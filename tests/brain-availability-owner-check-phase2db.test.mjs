/**
 * Phase 2D-B — availability request ledger persistence only.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildAvailabilityInquiryActionPlan,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  routeLiveActionPlan,
  executeLiveSideEffects,
} from "../src/brain/live/actionRouter.js";
import { createAvailabilityRequest, findExistingAvailabilityRequestForTurn } from "../src/services/availabilityRequestService.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";

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
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    this.store.setCalls += 1;
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
    this.store.updateCalls += 1;
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
}

class FakeCollectionRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)].join("/"));
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
    this.setCalls = 0;
    this.updateCalls = 0;
  }
  collection(name) {
    return {
      doc: (id) => ({
        collection: (childName) =>
          new FakeCollectionRef(this, [name, String(id), childName]),
      }),
    };
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
    explicitItem: { id: CIVIC_ID, name: "Honda Civic 2026 Oriel", displayLabel: "Honda Civic 2026 Oriel (White)" },
    trustedSessionItem: null,
    authoritativeItem: { id: CIVIC_ID, name: "Honda Civic 2026 Oriel", displayLabel: "Honda Civic 2026 Oriel (White)" },
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

test("1: flag off plans the owner-check action but does not persist a ledger entry", async () => {
  const plan = buildAvailabilityPlan(false);
  const ownerAction = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload.execute, false);

  const routed = routeLiveActionPlan(
    plan,
    {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: false,
      dmExecute: false,
    }
  );

  const fakeDb = new FakeDb();
  const sideEffects = await executeLiveSideEffects({
    actionPlan: plan,
    routed,
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: false,
      dmExecute: false,
    },
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: "phase2db-off",
      sessionKey: "session-001",
      participantKey: "cust-1",
      participantPhoneForDm: "923001234567",
      messageId: "msg-001",
      sourceRowKey: "row-001",
      guaranteeKey: "car-rental-queries::cust-1::msg-001",
      chatId: "car-rental-queries",
      chatType: "group",
    },
  });

  assert.ok(routed.blockedSideEffects.includes("AVAILABILITY_OWNER_CHECK_REQUIRED"));
  assert.deepEqual(sideEffects.sideEffectResults, {});
  assert.equal(sideEffects.bookingCreated, null);
  assert.equal(fakeDb.docs.size, 0);
  assert.equal(fakeDb.setCalls, 0);
});

test("2: flag on + execute true creates a pending availability request ledger doc only", async () => {
  const plan = buildAvailabilityPlan(true);
  const ownerAction = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload.execute, true);

  const routed = routeLiveActionPlan(
    plan,
    {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      dmExecute: false,
    }
  );

  const fakeDb = new FakeDb();
  const result = await executeLiveSideEffects({
    actionPlan: plan,
    routed,
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      dmExecute: false,
    },
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: "phase2db-on",
      sessionKey: "session-001",
      participantKey: "cust-1",
      participantPhoneForDm: "923001234567",
      messageId: "msg-001",
      sourceRowKey: "row-001",
      guaranteeKey: "car-rental-queries::cust-1::msg-001",
      chatId: "car-rental-queries",
      chatType: "group",
    },
  });

  assert.ok(routed.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED" && a.allowed === true && a.execute === true));
  assert.ok(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.ok, true);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.created, true);
  assert.equal(result.bookingCreated, null);
  assert.equal(fakeDb.docs.size, 1);
  assert.equal(fakeDb.setCalls, 1);

  const [stored] = [...fakeDb.docs.values()];
  assert.equal(stored.requestId, result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId);
  assert.equal(stored.businessId, BUSINESS_ID);
  assert.equal(stored.itemId, CIVIC_ID);
  assert.equal(stored.itemLabel, "Honda Civic 2026 Oriel (White)");
  assert.equal(stored.status, "pending");
  assert.equal(stored.ownerNotificationStatus, "not_started");
  assert.equal(stored.approvalCustomerNotificationStatus, "not_started");
  assert.equal(stored.sourceIdentity.participantKey, "cust-1");
  assert.equal(stored.sourceIdentity.sourceTurnKey, "car-rental-queries::cust-1::msg-001");
  assert.equal(stored.canonicalAvailabilityStatus, "available");
  assert.equal(stored.priceQuote.status, "not_requested");
  assert.equal(stored.customerDmTarget, "923001234567");
  assert.equal(stored.ownerTarget, null);
});

test("3: same inbound turn is idempotent and reuses the same deterministic request id", async () => {
  const fakeDb = new FakeDb();
  const payload = {
    businessId: BUSINESS_ID,
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    durationDays: 3,
    canonicalAvailability: { status: "available", isAvailable: true },
    canonicalPriceQuote: { status: "not_requested", total: null },
    participant: { key: "cust-1", identity: "stable" },
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "stable",
      chatId: "car-rental-queries",
      chatType: "group",
      sourceMessageId: "msg-001",
      sourceRowKey: "row-001",
      guaranteeKey: "car-rental-queries::cust-1::msg-001",
      sourceTurnKey: "car-rental-queries::cust-1::msg-001",
    },
    sourceMessageId: "msg-001",
    sourceRowKey: "row-001",
    guaranteeKey: "car-rental-queries::cust-1::msg-001",
    sourceTurnKey: "car-rental-queries::cust-1::msg-001",
    sourceChatId: "car-rental-queries",
    sourceChatType: "group",
    customerDmTarget: "923001234567",
  };

  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID, participantPhoneForDm: "923001234567" },
  });
  const second = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID, participantPhoneForDm: "923001234567" },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(fakeDb.docs.size, 1);
  assert.equal(fakeDb.setCalls, 1);
});

test("4: canonical snapshot fields are persisted without re-deriving from raw sources", async () => {
  const fakeDb = new FakeDb();
  const payload = {
    businessId: BUSINESS_ID,
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    durationDays: 3,
    requestedDates: ["2026-06-23"],
    canonicalAvailability: {
      status: "available",
      isAvailable: true,
      bookingAware: true,
      blockingBookingCount: 0,
    },
    canonicalPriceQuote: {
      status: "quoted",
      durationDays: 3,
      total: 12345,
      currency: "PKR",
    },
    participant: { key: "cust-1", identity: "stable", memoryAllowed: true },
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "stable",
      chatId: "car-rental-queries",
      chatType: "group",
      sourceMessageId: "msg-002",
      sourceRowKey: "row-002",
      guaranteeKey: "car-rental-queries::cust-1::msg-002",
      sourceTurnKey: "car-rental-queries::cust-1::msg-002",
    },
    sourceMessageId: "msg-002",
    sourceRowKey: "row-002",
    guaranteeKey: "car-rental-queries::cust-1::msg-002",
    sourceTurnKey: "car-rental-queries::cust-1::msg-002",
    sourceChatId: "car-rental-queries",
    sourceChatType: "group",
    customerDmTarget: "923001234567",
  };

  const result = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID, participantPhoneForDm: "923001234567" },
  });

  assert.equal(result.ok, true);
  const stored = await findExistingAvailabilityRequestForTurn({
    db: fakeDb,
    businessId: BUSINESS_ID,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID, participantPhoneForDm: "923001234567" },
  });
  assert.equal(stored?.requestId, result.requestId);
  assert.equal(stored?.businessId, BUSINESS_ID);
  assert.equal(stored?.itemId, CIVIC_ID);
  assert.equal(stored?.itemLabel, "Honda Civic 2026 Oriel (White)");
  assert.equal(stored?.status, "pending");
  assert.equal(stored?.requestedDuration, 3);
  assert.deepEqual(stored?.requestedDates, ["2026-06-23"]);
  assert.equal(stored?.canonicalAvailabilityStatus, "available");
  assert.equal(stored?.priceQuote?.total, 12345);
  assert.equal(stored?.sourceIdentity?.sourceTurnKey, "car-rental-queries::cust-1::msg-002");
});

test("5: resolveBusinessTurnContext exposes availability owner-check execution from policy facts", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "phase2db-facts",
    businessId: BUSINESS_ID,
    rawMessage: "Civic 3 din ke liye available hai?",
    turnContextInput: baseTurnContextInput(),
    catalogItems: [],
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      dmExecute: false,
    },
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });

  assert.equal(facts.actions.availabilityOwnerCheckExecute, true);
  assert.equal(facts.actions.allowed.includes("AVAILABILITY_OWNER_CHECK_REQUIRED"), true);
  assert.equal(facts.sourceIdentity.sourceTurnKey, "car-rental-queries::cust-1::msg-001");
});
