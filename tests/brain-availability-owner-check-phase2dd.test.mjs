import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  handleAvailabilityRequestApproval,
  parseAvailabilityApprovalButtonId,
  parseAvailabilityApprovalMessage,
} from "../src/services/availabilityApprovalService.js";
import { parseApprovalMessage } from "../src/services/bookingApprovalService.js";
import {
  buildAvailabilityCustomerNotificationMessage,
  sendAvailabilityCustomerNotification,
} from "../src/services/availabilityCustomerNotificationService.js";
import { pollLocalAvailabilityContinuations } from "../src/services/localAvailabilityContinuationPoller.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const OWNER_PHONE = "+923331234567";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const CIVIC_REQUEST_ID = "avr_7a9c8f4c2d1e5b6a7c8d9e0f";

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  data() {
    const value = this.store.docs.get(this.key);
    return value ? structuredClone(value) : undefined;
  }
}

class FakeDocRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  get key() {
    return this.pathParts.join("/");
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prev = this.store.docs.get(this.key) || {};
    const next =
      options?.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) {
      throw new Error(`missing doc ${this.key}`);
    }
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.pathParts, name]);
  }
}

class FakeCollectionRef {
  constructor(store, pathParts, conditions = [], resultLimit = null) {
    this.store = store;
    this.pathParts = pathParts;
    this.conditions = conditions;
    this.resultLimit = resultLimit;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
  }
  where(field, op, value) {
    return new FakeCollectionRef(
      this.store,
      this.pathParts,
      [...this.conditions, { field, op, value }],
      this.resultLimit
    );
  }
  limit(n) {
    return new FakeCollectionRef(this.store, this.pathParts, this.conditions, n);
  }
  async get() {
    const entries = [];
    for (const [key, value] of this.store.docs.entries()) {
      if (!key.startsWith(`${this.pathParts.join("/")}/`)) continue;
      const tail = key.slice(this.pathParts.join("/").length + 1);
      if (tail.includes("/")) continue;
      entries.push([tail, value]);
    }
    let filtered = entries.filter(([, node]) => {
      for (const condition of this.conditions) {
        if (condition.op !== "==") return false;
        if (node?.[condition.field] !== condition.value) return false;
      }
      return true;
    });
    if (this.resultLimit != null) {
      filtered = filtered.slice(0, this.resultLimit);
    }
    return {
      docs: filtered.map(([id, node]) => ({
        id,
        ref: new FakeDocRef(this.store, [...this.pathParts, id]),
        data: () => structuredClone(node),
      })),
    };
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
}

function seedBusiness(fakeDb, ownerPhone = OWNER_PHONE) {
  return fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: ownerPhone,
    businessProfile: {
      ownerNotificationPhone: ownerPhone,
    },
  });
}

function seedAvailabilityRequest(fakeDb, requestId, overrides = {}) {
  return fakeDb
    .collection("businesses")
    .doc(BUSINESS_ID)
    .collection("availabilityRequests")
    .doc(requestId)
    .set({
      requestId,
      businessId: BUSINESS_ID,
      itemId: CIVIC_ID,
      itemLabel: "Honda Civic 2026 Oriel (White)",
      sourceChatId: "Rental Leads",
      sourceChatType: "group",
      customerParticipantId: "cust-1",
      customerDmTarget: "+923001111111",
      ownerTarget: OWNER_PHONE,
      status: "pending",
      requestedDuration: 3,
      requestedDates: [],
      canonicalAvailabilityStatus: "available",
      priceQuote: {
        status: "quoted",
        total: 45000,
        currency: "PKR",
      },
      ownerNotificationStatus: "not_started",
      approvalCustomerNotificationStatus: "not_started",
      sourceIdentity: {
        participantKey: "cust-1",
        participantIdentity: "Adeel malik",
        chatId: "Rental Leads",
        chatType: "group",
        sourceMessageId: "msg-001",
        sourceRowKey: "row-001",
        sourceTurnKey: "turn-001",
      },
      sourceTurnKey: "turn-001",
      createdAt: new Date("2026-06-23T00:00:00.000Z"),
      expiresAt: new Date("2026-06-30T00:00:00.000Z"),
      updatedAt: new Date("2026-06-23T00:00:00.000Z"),
      ...overrides,
    });
}

function getAvailabilityDoc(fakeDb, requestId) {
  return fakeDb.docs.get(`businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`);
}

test("availability approval parser is strict and does not collide with booking approvals", () => {
  assert.deepEqual(parseAvailabilityApprovalMessage("APPROVE avr_123"), {
    action: "approve",
    requestId: "avr_123",
  });
  assert.deepEqual(parseAvailabilityApprovalMessage("REJECT avr_123"), {
    action: "reject",
    requestId: "avr_123",
  });
  assert.equal(parseAvailabilityApprovalMessage("APPROVE booking123"), null);
  assert.equal(parseAvailabilityApprovalMessage("please approve avr_123"), null);
  assert.deepEqual(parseAvailabilityApprovalButtonId("approve:avr_123"), {
    action: "approve",
    requestId: "avr_123",
  });
  assert.equal(parseAvailabilityApprovalButtonId("approve:booking123"), null);
  assert.deepEqual(parseApprovalMessage("APPROVE booking123"), {
    action: "approve",
    bookingId: "booking123",
  });
});

test("owner approve updates availability request status and keeps booking flow untouched", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID);

  const result = await handleAvailabilityRequestApproval({
    db: fakeDb,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: `APPROVE ${CIVIC_REQUEST_ID}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "approved");
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.status, "approved");
  assert.equal(stored.ownerDecisionBy, OWNER_PHONE);
  assert.equal(stored.approvalCustomerNotificationStatus, "pending");
  assert.equal(fakeDb.docs.has(`businesses/${BUSINESS_ID}/bookings/${CIVIC_REQUEST_ID}`), false);
});

test("unauthorized owner cannot update availability request", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID);

  const result = await handleAvailabilityRequestApproval({
    db: fakeDb,
    businessId: BUSINESS_ID,
    senderPhone: "+923009999999",
    messageText: `REJECT ${CIVIC_REQUEST_ID}`,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNAUTHORIZED_OWNER");
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.status, "pending");
});

test("approval stays pending when customer DM flag is off", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID, {
    approvalCustomerNotificationStatus: "pending",
    status: "approved",
  });
  const sendCalls = [];

  const result = await pollLocalAvailabilityContinuations({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    availabilityCustomerDmExecute: false,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    replyPrivatelyFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true, verificationPassed: true };
    },
  });

  assert.equal(result.disabled, true);
  assert.equal(sendCalls.length, 0);
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.approvalCustomerNotificationStatus, "pending");
});

test("cloud DM sends approved availability copy and marks request sent", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID, {
    approvalCustomerNotificationStatus: "pending",
    status: "approved",
    customerDmTarget: "+923001111111",
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "Adeel malik",
      chatId: "Rental Leads",
      chatType: "group",
      sourceMessageId: "msg-001",
      sourceRowKey: "row-001",
      sourceTurnKey: "turn-001",
    },
  });
  const sendCalls = [];

  const result = await pollLocalAvailabilityContinuations({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    availabilityCustomerDmExecute: true,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true, providerMessageId: "msg-123" };
    },
    replyPrivatelyFn: async () => {
      throw new Error("reply privately should not be used when cloud DM target exists");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0][0], "+923001111111");
  assert.match(sendCalls[0][1], /Honda Civic 2026 Oriel \(White\) 3 din ke liye available hai/);
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
  assert.equal(stored.approvalCustomerNotificationMethod, "cloud_dm");
  assert.equal(stored.approvalCustomerNotificationError, undefined);
  assert.equal(fakeDb.docs.has(`businesses/${BUSINESS_ID}/bookings/${CIVIC_REQUEST_ID}`), false);
});

test("reply privately is used when cloud DM target is missing but Playwright source anchor exists", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID, {
    approvalCustomerNotificationStatus: "pending",
    status: "rejected",
    customerDmTarget: "",
    sourceChatId: "Rental Leads",
    sourceChatType: "group",
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "Adeel malik",
      chatId: "Rental Leads",
      chatType: "group",
      sourceMessageId: "msg-001",
      sourceRowKey: "row-001",
      sourceTurnKey: "turn-001",
    },
  });
  const replyCalls = [];

  const result = await pollLocalAvailabilityContinuations({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    availabilityCustomerDmExecute: true,
    sendWhatsAppMessageFn: async () => {
      throw new Error("cloud DM should not be used without customerDmTarget");
    },
    replyPrivatelyFn: async (opts) => {
      replyCalls.push(opts);
      return {
        ok: true,
        verificationPassed: true,
        dmOpened: true,
        dmMessageSent: true,
        dmChatTitle: "Adeel malik",
        dmPlaywrightChatKey: "Rental Leads",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(replyCalls.length, 1);
  assert.equal(replyCalls[0].bookingId, CIVIC_REQUEST_ID);
  assert.match(replyCalls[0].message, /Sorry, Honda Civic 2026 Oriel \(White\) 3 din ke liye available nahi hai/);
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
  assert.equal(stored.approvalCustomerNotificationMethod, "reply_privately");
});

test("missing customer DM target and missing Playwright anchor fail closed", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID, {
    approvalCustomerNotificationStatus: "pending",
    status: "approved",
    customerDmTarget: "",
    sourceChatId: "",
    sourceChatType: "",
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "Adeel malik",
      chatId: "",
      chatType: "",
      sourceMessageId: "",
      sourceRowKey: "",
      sourceTurnKey: "turn-001",
    },
  });
  const sendCalls = [];

  const result = await pollLocalAvailabilityContinuations({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    availabilityCustomerDmExecute: true,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    replyPrivatelyFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true, verificationPassed: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 0);
  const stored = getAvailabilityDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.approvalCustomerNotificationStatus, "skipped");
  assert.match(String(stored.approvalCustomerNotificationError ?? ""), /MISSING/);
});

test("sent customer notification is idempotent", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  await seedAvailabilityRequest(fakeDb, CIVIC_REQUEST_ID, {
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationMethod: "cloud_dm",
    status: "approved",
    customerDmTarget: "+923001111111",
  });
  const sendCalls = [];

  const result = await pollLocalAvailabilityContinuations({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    availabilityCustomerDmExecute: true,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    replyPrivatelyFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true, verificationPassed: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 0);
});

test("customer DM copy stays natural", () => {
  const approved = buildAvailabilityCustomerNotificationMessage({
    status: "approved",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 3,
  });
  const rejected = buildAvailabilityCustomerNotificationMessage({
    status: "rejected",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 3,
  });

  assert.match(approved, /Honda Civic 2026 Oriel \(White\) 3 din ke liye available hai\./);
  assert.match(approved, /Booking continue kar dun\?/);
  assert.match(rejected, /Sorry, Honda Civic 2026 Oriel \(White\) 3 din ke liye available nahi hai\./);
  assert.match(rejected, /Koi aur car dekhni hai\?/);
  assert.doesNotMatch(approved, /\b(action plan|ledger|system|pipeline|execution flag)\b/i);
  assert.doesNotMatch(rejected, /\b(action plan|ledger|system|pipeline|execution flag)\b/i);
});

