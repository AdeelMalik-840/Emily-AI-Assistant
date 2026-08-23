/**
 * Phase 2D-C — availability owner notification adapter only.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  routeLiveActionPlan,
  executeLiveSideEffects,
} from "../src/brain/live/actionRouter.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const OWNER_PHONE = "+923331234567";

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
      options && options.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) {
      throw new Error("MISSING_DOC");
    }
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.pathParts, name]);
  }
}

class FakeCollectionRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
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

function baseTurnContextInput(overrides = {}) {
  return {
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    participantIdentity: "stable",
    participantKey: "cust-1",
    memoryAllowed: true,
    messageText: "Civic 3 din ke liye available hai?",
    turnShape: "explicit_item_availability",
    explicitItem: {
      id: CIVIC_ID,
      name: "Honda Civic 2026 Oriel",
      displayLabel: "Honda Civic 2026 Oriel (White)",
    },
    trustedSessionItem: null,
    authoritativeItem: {
      id: CIVIC_ID,
      name: "Honda Civic 2026 Oriel",
      displayLabel: "Honda Civic 2026 Oriel (White)",
    },
    requestedField: "availability",
    duration: 3,
    contact: null,
    sourceMessageId: "msg-001",
    sourceRowKey: "row-001",
    guaranteeKey: "car-rental-queries::cust-1::msg-001",
    shouldClarifyItem: false,
    clarificationReply: null,
    suppressFuzzyCatalog: false,
    _emilySessionKey: "session-001",
    _authority: {},
    ...overrides,
  };
}

function canonicalBusinessContext(overrides = {}) {
  return {
    resolvedBusinessTurnContext: Object.freeze({
      businessId: BUSINESS_ID,
      resolvedItem: Object.freeze({
        id: CIVIC_ID,
        name: "Honda Civic 2026 Oriel",
        displayLabel: "Honda Civic 2026 Oriel (White)",
      }),
      turn: Object.freeze({
        durationDays: 3,
        sourceMessageId: "msg-001",
        sourceRowKey: "row-001",
        guaranteeKey: "car-rental-queries::cust-1::msg-001",
        sourceTurnKey: "car-rental-queries::cust-1::msg-001",
      }),
      participant: Object.freeze({
        key: "cust-1",
        identity: "stable",
        memoryAllowed: true,
      }),
      sourceIdentity: Object.freeze({
        participantKey: "cust-1",
        participantIdentity: "stable",
        chatId: "car-rental-queries",
        chatType: "group",
        sourceMessageId: "msg-001",
        sourceRowKey: "row-001",
        guaranteeKey: "car-rental-queries::cust-1::msg-001",
        sourceTurnKey: "car-rental-queries::cust-1::msg-001",
      }),
      verified: Object.freeze({
        availability: Object.freeze({
          status: "available",
          isAvailable: true,
          source: "computeUserFacingAvailability",
          bookingAware: true,
          blockingBookingCount: 0,
        }),
        priceQuote: Object.freeze({
          status: "not_requested",
          durationDays: null,
          total: null,
          currency: "PKR",
        }),
      }),
      actions: Object.freeze({
        bookingExecute: false,
        ownerExecute: false,
        availabilityOwnerCheckExecute: overrides.availabilityOwnerCheckExecute === true,
        dmExecute: false,
        allowed: ["REPLY"],
        blocked: [
          "CREATE_BOOKING",
          "NOTIFY_OWNER",
          "AVAILABILITY_OWNER_CHECK_REQUIRED",
          "DM_CUSTOMER",
          "HANDOFF_DM",
          "SEND_IMAGES",
        ],
      }),
      forbiddenClaims: Object.freeze(["booking_created", "owner_notified", "dm_sent", "image_sent"]),
      replyConstraints: Object.freeze({
        mustNotInventPrice: true,
        mustNotInventAvailability: true,
        mustNotClaimBlockedActions: true,
      }),
      ...overrides.contextExtras,
    }),
  };
}

function buildAvailabilityPlan(availabilityOwnerCheckExecute) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        turnId: "turn-001",
        businessId: BUSINESS_ID,
        channelId: "whatsapp_web",
        chatKey: "car-rental-queries",
        participantKey: "cust-1",
        text: "Civic 3 din ke liye available hai?",
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: "turn-001::canonical",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
      itemSource: "explicit",
      askedField: "availability",
      durationDays: 3,
      signals: { availabilityAsk: true },
    },
    catalogItems: [],
    businessContext: canonicalBusinessContext({ availabilityOwnerCheckExecute }),
  });
}

async function seedBusiness(fakeDb) {
  await fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: {
      ownerNotificationPhone: OWNER_PHONE,
    },
  });
}

function getAvailabilityDoc(fakeDb, requestId) {
  return fakeDb.docs.get(`businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`);
}

test("1: notify flag off keeps availability ledger only and does not send owner notification", async () => {
  const plan = buildAvailabilityPlan(true);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const sendCalls = [];

  const routed = routeLiveActionPlan(plan, {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: false,
    dmExecute: false,
  });

  const result = await executeLiveSideEffects({
    actionPlan: plan,
    routed,
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      availabilityOwnerNotifyExecute: false,
      dmExecute: false,
    },
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: "phase2dc-off",
      sessionKey: "session-001",
      participantKey: "cust-1",
      participantPhoneForDm: "923001234567",
      messageId: "msg-001",
      sourceRowKey: "row-001",
      guaranteeKey: "car-rental-queries::cust-1::msg-001",
      chatId: "car-rental-queries",
      chatType: "group",
      sendWhatsAppMessageFn: async (...args) => {
        sendCalls.push(args);
        return { ok: true };
      },
    },
  });

  assert.equal(sendCalls.length, 0);
  assert.ok(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.created, true);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION, undefined);
  assert.equal(result.bookingCreated, null);

  const requestId = result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId;
  const stored = getAvailabilityDoc(fakeDb, requestId);
  assert.ok(stored);
  assert.equal(stored.ownerNotificationStatus, "not_started");
  assert.equal(stored.ownerTarget, null);
  assert.equal([...fakeDb.docs.keys()].some((key) => key.includes("/bookings/")), false);
});

test("2: notify flag sends a natural owner prompt with request-bound Yes/No buttons", async () => {
  const plan = buildAvailabilityPlan(true);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const sendCalls = [];

  const routed = routeLiveActionPlan(plan, {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: true,
    dmExecute: false,
  });

  const result = await executeLiveSideEffects({
    actionPlan: plan,
    routed,
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      availabilityOwnerNotifyExecute: true,
      dmExecute: false,
    },
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: "phase2dc-on",
      sessionKey: "session-001",
      participantKey: "cust-1",
      participantPhoneForDm: "923001234567",
      messageId: "msg-001",
      sourceRowKey: "row-001",
      guaranteeKey: "car-rental-queries::cust-1::msg-001",
      chatId: "car-rental-queries",
      chatType: "group",
      sendWhatsAppMessageFn: async (...args) => {
        sendCalls.push(args);
        return { ok: true, providerMessageId: "provider-123" };
      },
    },
  });

  assert.equal(sendCalls.length, 1);
  const [to, text, buttons, credentials, opts] = sendCalls[0];
  assert.equal(to, OWNER_PHONE);
  assert.equal(credentials, undefined);
  assert.deepEqual(opts, { signal: undefined });

  assert.ok(result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.ok, true);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.sent, true);

  const requestId = result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId;
  assert.equal(
    text,
    "Customer ko Honda Civic 2026 Oriel (White) 3 din ke liye chahiye. Available hai?"
  );
  assert.equal(text.includes(requestId), false);
  assert.doesNotMatch(text, /APPROVE|REJECT/i);
  assert.deepEqual(buttons, [
    { id: `approve:${requestId}`, title: "Yes" },
    { id: `reject:${requestId}`, title: "No" },
  ]);
  const stored = getAvailabilityDoc(fakeDb, requestId);
  assert.ok(stored);
  assert.equal(stored.ownerNotificationStatus, "sent");
  assert.equal(stored.ownerNotificationAt instanceof Date, true);
  assert.equal(stored.ownerTarget, OWNER_PHONE);
  assert.equal(stored.ownerNotificationProviderMessageId, "provider-123");
  assert.equal(stored.status, "pending");
  assert.equal(stored.customerDmTarget, "923001234567");
  assert.equal(result.bookingCreated, null);
  assert.equal([...fakeDb.docs.keys()].some((key) => key.includes("/bookings/")), false);
});

test("2b: interactive send failure records failure and does not claim notification", async () => {
  const plan = buildAvailabilityPlan(true);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const flags = {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: true,
    dmExecute: false,
  };

  const result = await executeLiveSideEffects({
    actionPlan: plan,
    routed: routeLiveActionPlan(plan, flags),
    flags,
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: "phase2dc-send-failure",
      sessionKey: "session-001",
      participantKey: "cust-1",
      participantPhoneForDm: "923001234567",
      messageId: "msg-failure",
      sourceRowKey: "row-failure",
      guaranteeKey: "car-rental-queries::cust-1::msg-failure",
      chatId: "car-rental-queries",
      chatType: "group",
      sendWhatsAppMessageFn: async () => ({
        ok: false,
        httpStatus: 400,
        error: { message: "outside customer service window" },
      }),
    },
  });

  const notification = result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION;
  assert.equal(notification.ok, false);
  assert.match(notification.reason, /outside customer service window/);
  const requestId = result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId;
  const stored = getAvailabilityDoc(fakeDb, requestId);
  assert.equal(stored.ownerNotificationStatus, "failed");
  assert.match(stored.ownerNotificationError, /outside customer service window/);
  assert.equal(stored.ownerNotificationAt instanceof Date, true);
  assert.equal(stored.ownerNotificationProviderMessageId ?? null, null);
});

test("3: repeated execution does not duplicate owner notification", async () => {
  const plan = buildAvailabilityPlan(true);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const sendCalls = [];
  const flags = {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: true,
    dmExecute: false,
  };

  const executionContext = {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    traceId: "phase2dc-idempotent",
    sessionKey: "session-001",
    participantKey: "cust-1",
    participantPhoneForDm: "923001234567",
    messageId: "msg-001",
    sourceRowKey: "row-001",
    guaranteeKey: "car-rental-queries::cust-1::msg-001",
    chatId: "car-rental-queries",
    chatType: "group",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
  };

  await executeLiveSideEffects({
    actionPlan: plan,
    routed: routeLiveActionPlan(plan, flags),
    flags,
    executionContext,
  });
  const second = await executeLiveSideEffects({
    actionPlan: plan,
    routed: routeLiveActionPlan(plan, flags),
    flags,
    executionContext,
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(second.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.skipped, true);
  const requestId = second.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId;
  const stored = getAvailabilityDoc(fakeDb, requestId);
  assert.equal(stored.ownerNotificationStatus, "sent");
  assert.equal([...fakeDb.docs.keys()].some((key) => key.includes("/bookings/")), false);
});
