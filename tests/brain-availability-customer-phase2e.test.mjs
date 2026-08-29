import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildApprovedAvailabilityCustomerMessage,
  buildApprovedAvailabilityCustomerMessageWithoutPrice,
  buildRejectedAvailabilityNoOptionsMessage,
  buildRejectedAvailabilityWithAlternativesMessage,
  resolveAvailabilityApprovedPriceQuote,
} from "../src/services/availabilityMessageBuilder.js";
import {
  buildAvailabilityCustomerNotificationMessage,
  sendAvailabilityCustomerNotification,
} from "../src/services/availabilityCustomerNotificationService.js";
import {
  classifyAvailabilityCustomerDmIntent,
  executeAvailabilityCustomerConfirmBooking,
  handleAvailabilityCustomerCloudInbound,
  selectAvailabilityRequestForCustomerMessage,
} from "../src/services/availabilityCustomerConfirmService.js";
import {
  buildConfirmExpiresAt,
  claimAvailabilityRequestCustomerConfirmProcessing,
} from "../src/services/availabilityRequestService.js";
import { isEmilyBrainV2AvailabilityConfirmExecuteEnabled } from "../src/brain/config/liveFeatureFlags.js";
import { decideWaitingConfirmFromLegacyClassifierForTests,
  composeWaitingConfirmExecutionReplyForTests } from "./helpers/waitingConfirmBrainTestDouble.mjs";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_REQUEST_ID = "avr_phase2e_civic";
const CUSTOMER_PHONE = "+923001111111";

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
  async runTransaction(fn) {
    return fn({
      get: (ref) => ref.get(),
      update: (ref, data) => ref.update(data),
      set: (ref, data, options) => ref.set(data, options),
    });
  }
}

function seedWaitingConfirmRequest(fakeDb, requestId, overrides = {}) {
  const sentAt = new Date();
  return fakeDb
    .collection("businesses")
    .doc(BUSINESS_ID)
    .collection("availabilityRequests")
    .doc(requestId)
    .set({
      requestId,
      businessId: BUSINESS_ID,
      itemId: "honda_civic_2026",
      itemLabel: "Honda Civic 2026",
      status: "approved",
      requestedDuration: 3,
      customerDmTarget: CUSTOMER_PHONE,
      customerPhone: CUSTOMER_PHONE,
      approvalCustomerNotificationStatus: "sent",
      approvalCustomerNotificationAt: sentAt,
      customerConfirmationStatus: "waiting_confirm",
      customerConfirmationChannel: "waiting_confirm_cloud",
      confirmExpiresAt: buildConfirmExpiresAt(sentAt),
      customerConfirmProcessingStatus: "idle",
      lastCustomerDmPromptType: "booking_confirmation_prompt",
      lastCustomerNotifyMessage:
        "Honda Civic 2026 3 din ke liye available hai. Book kar du?",
      priceQuote: { status: "quoted", total: 24000, currency: "PKR", durationDays: 3 },
      sourceIdentity: { participantKey: "cust-1", chatId: "Rental Leads", chatType: "group" },
      ...overrides,
    });
}

function getRequestDoc(fakeDb, requestId) {
  return fakeDb.docs.get(`businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`);
}

test("bootstrap message is not used for approved reply privately path", async () => {
  const prevExtraction = process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED;
  process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED = "true";
  const fakeDb = new FakeDb();
  await fakeDb.collection("businesses").doc(BUSINESS_ID).collection("availabilityRequests").doc(CIVIC_REQUEST_ID).set({
    requestId: CIVIC_REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 3,
    approvalCustomerNotificationStatus: "pending",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
    sourceChatId: "Rental Leads",
    sourceChatType: "group",
    sourceIdentity: {
      participantKey: "cust-1",
      chatId: "Rental Leads",
      chatType: "group",
      sourceMessageId: "msg-001",
      sourceRowKey: "row-001",
    },
  });
  const replyCalls = [];
  const sendCalls = [];
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: CIVIC_REQUEST_ID,
      sendWhatsAppMessageFn: async (...args) => {
        sendCalls.push(args);
        return { ok: true };
      },
      replyPrivatelyFn: async (opts) => {
        replyCalls.push(opts);
        return {
          ok: true,
          verificationPassed: true,
          dmChatTitle: "Adeel",
          dmPlaywrightChatKey: "dm-adeel",
        };
      },
      extractDmContactPhoneFn: async () => ({
        ok: true,
        phone: CUSTOMER_PHONE,
        contactInfo: { displayName: "Adeel" },
      }),
      refocusGroupFn: async () => null,
    });
    assert.equal(result.ok, true);
    assert.equal(sendCalls.length, 0);
    assert.match(replyCalls[0].message, /Book kar du\?/);
    assert.doesNotMatch(replyCalls[0].message, /Details DM pe share kar raha hun/i);
  } finally {
    if (prevExtraction === undefined) delete process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED;
    else process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED = prevExtraction;
  }
});

test("existing phone case still uses cloud directly without reply privately", async () => {
  const fakeDb = new FakeDb();
  await fakeDb.collection("businesses").doc(BUSINESS_ID).collection("availabilityRequests").doc(CIVIC_REQUEST_ID).set({
    requestId: CIVIC_REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 3,
    approvalCustomerNotificationStatus: "pending",
    customerDmTarget: CUSTOMER_PHONE,
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
  });
  const sendCalls = [];
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: CIVIC_REQUEST_ID,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    replyPrivatelyFn: async () => {
      throw new Error("reply privately must not run when phone exists");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "cloud_dm");
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0][1], /Book kar du\?/);
  const stored = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.customerConfirmationChannel, "cloud_dm");
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
});

test("approved customer message includes item duration rent and Book kar du", () => {
  const request = {
    itemLabel: "Honda Civic 2026",
    requestedDuration: 3,
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
  };
  const resolved = resolveAvailabilityApprovedPriceQuote(request, null);
  assert.equal(resolved.ok, true);
  const built = buildApprovedAvailabilityCustomerMessage(request, resolved.priceQuote);
  assert.equal(built.ok, true);
  assert.match(built.message, /Honda Civic 2026 3 din ke liye available hai/);
  assert.match(built.message, /3 din ka rent 24,000 PKR hoga/);
  assert.match(built.message, /Book kar du\?/);
});

test("missing price blocks direct priced message builder with PRICE_MISSING", () => {
  const built = buildApprovedAvailabilityCustomerMessage(
    { itemLabel: "Honda Civic 2026", requestedDuration: 3 },
    null
  );
  assert.equal(built.ok, false);
  assert.equal(built.reason, "PRICE_MISSING");
});

test("catalog pricing resolves 8000 daily x 2 days for not_requested priceQuote", () => {
  const request = {
    itemId: "honda_civic_2026_oriel_white_7e961e31",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 2,
    status: "approved",
    priceQuote: {
      status: "not_requested",
      dailyRate: null,
      total: null,
      currency: "PKR",
      source: null,
    },
  };
  const catalogRow = {
    id: "honda_civic_2026_oriel_white_7e961e31",
    name: "Honda Civic 2026 Oriel",
    pricing: { currency: "PKR", daily: 8000, monthly: 165000 },
  };
  const resolved = resolveAvailabilityApprovedPriceQuote(request, catalogRow);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.priceQuote.total, 16000);
  const built = buildAvailabilityCustomerNotificationMessage(request, { catalogRow });
  assert.equal(built.ok, true);
  assert.match(built.message, /16,000 PKR hoga/);
  assert.match(built.message, /Book kar du\?/);
});

test("approved notification uses no-price fallback when catalog pricing missing", () => {
  const request = {
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 2,
    status: "approved",
  };
  const built = buildAvailabilityCustomerNotificationMessage(request, { catalogRow: null });
  assert.equal(built.ok, true);
  assert.equal(built.usedNoPriceFallback, true);
  assert.match(
    built.message,
    /Honda Civic 2026 Oriel \(White\) 2 din ke liye available hai\. Book kar du\?/
  );
  assert.doesNotMatch(built.message, /ka rent/);
});

test("no-price fallback notification proceeds via reply privately", async () => {
  const fakeDb = new FakeDb();
  await fakeDb.collection("businesses").doc(BUSINESS_ID).collection("availabilityRequests").doc(CIVIC_REQUEST_ID).set({
    requestId: CIVIC_REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    status: "approved",
    requestedDuration: 2,
    approvalCustomerNotificationStatus: "pending",
    priceQuote: { status: "not_requested", total: null, dailyRate: null, currency: "PKR" },
    sourceChatId: "Rental Leads",
    sourceChatType: "group",
    sourceIdentity: {
      participantKey: "cust-1",
      chatId: "Rental Leads",
      chatType: "group",
      sourceMessageId: "msg-001",
      sourceRowKey: "row-001",
    },
  });
  const replyCalls = [];
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: CIVIC_REQUEST_ID,
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    replyPrivatelyFn: async (opts) => {
      replyCalls.push(opts);
      return {
        ok: true,
        verificationPassed: true,
        dmChatTitle: "Adeel",
        dmPlaywrightChatKey: "dm-adeel",
      };
    },
    extractDmContactPhoneFn: async () => ({ ok: false, reason: "PHONE_EXTRACTION_DISABLED" }),
    refocusGroupFn: async () => null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "reply_privately");
  assert.match(replyCalls[0].message, /2 din ke liye available hai\. Book kar du\?/);
  assert.doesNotMatch(replyCalls[0].message, /PRICE_MISSING/);
  const stored = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
  assert.notEqual(stored.approvalCustomerNotificationError, "PRICE_MISSING");
});

test("stored quoted priceQuote still builds priced approved message unchanged", () => {
  const request = {
    itemLabel: "Honda Civic 2026",
    requestedDuration: 3,
    status: "approved",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
  };
  const built = buildAvailabilityCustomerNotificationMessage(request, { catalogRow: null });
  assert.equal(built.ok, true);
  assert.equal(built.usedNoPriceFallback, undefined);
  assert.match(built.message, /3 din ka rent 24,000 PKR hoga/);
  assert.match(built.message, /Book kar du\?/);
});

test("rejected alternatives message uses verified labels only", () => {
  const message = buildRejectedAvailabilityWithAlternativesMessage(
    { itemLabel: "Honda Civic 2026", requestedDuration: 3 },
    ["Toyota Corolla 2024", "Honda City 2023"]
  );
  assert.match(message, /Honda Civic 2026 3 din ke liye available nahi hai/);
  assert.match(message, /Toyota Corolla 2024 aur Honda City 2023 available hain/);
  assert.match(message, /Kya aap in options ko check karna chahenge\?/);
});

test("rejected no-options message is exact copy", () => {
  assert.equal(buildRejectedAvailabilityNoOptionsMessage(), "Sorry abi koi option available ni hai.");
});

test("customer DM intent classification covers confirm decline price alternatives", () => {
  assert.equal(classifyAvailabilityCustomerDmIntent("haan book kar do"), "confirm");
  assert.equal(classifyAvailabilityCustomerDmIntent("yes confirm"), "confirm");
  assert.equal(classifyAvailabilityCustomerDmIntent("nahi"), "decline");
  assert.equal(classifyAvailabilityCustomerDmIntent("rent kitna hai?"), "price");
  assert.equal(classifyAvailabilityCustomerDmIntent("koi aur option hai?"), "alternatives");
});

test("multiple waiting requests disambiguate by item mention", () => {
  const requests = [
    { itemLabel: "Honda Civic 2026", requestedDuration: 3 },
    { itemLabel: "Toyota Corolla 2024", requestedDuration: 2 },
  ];
  const civicPick = selectAvailabilityRequestForCustomerMessage(requests, "Civic book kar do");
  assert.equal(civicPick.reason, "ITEM_MENTION_DISAMBIGUATED");
  assert.match(civicPick.request.itemLabel, /Civic/);
  const ambiguous = selectAvailabilityRequestForCustomerMessage(requests, "haan book kar do");
  assert.equal(ambiguous.reason, "AMBIGUOUS");
  assert.match(ambiguous.disambiguationReply, /Kaunsi car book karun/);
});

test("cloud confirm without trusted waiting request sends clarification not booking", async () => {
  const fakeDb = new FakeDb();
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan book kar do",
    messageId: "in-001",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests: composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.handled, false);
  assert.equal(sendCalls.length, 0);
});

test("cloud confirm with waiting request but execute disabled does not create booking", async () => {
  const fakeDb = new FakeDb();
  await seedWaitingConfirmRequest(fakeDb, CIVIC_REQUEST_ID);
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "book kar do",
    messageId: "in-002",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: false,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests: composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.handled, true);
  assert.equal(result.action, "confirm_failed");
  assert.equal(sendCalls.length, 1);
  const stored = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.linkedBookingId, undefined);
});

test("cloud decline marks request declined", async () => {
  const fakeDb = new FakeDb();
  await seedWaitingConfirmRequest(fakeDb, CIVIC_REQUEST_ID);
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "nahi rehne dein",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests: composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.handled, true);
  assert.equal(result.action, "declined");
  const stored = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.customerConfirmationStatus, "declined");
});

test("cloud price question replies with approved quote context", async () => {
  const fakeDb = new FakeDb();
  await seedWaitingConfirmRequest(fakeDb, CIVIC_REQUEST_ID);
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "rent kitna hai?",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests: composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.handled, true);
  assert.equal(result.action, "price");
  assert.match(sendCalls[0][1], /24,000 PKR/);
});

test("duplicate confirm claim is blocked after processing starts", async () => {
  const fakeDb = new FakeDb();
  await seedWaitingConfirmRequest(fakeDb, CIVIC_REQUEST_ID);
  const request = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  const first = await claimAvailabilityRequestCustomerConfirmProcessing({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: CIVIC_REQUEST_ID,
  });
  assert.equal(first.ok, true);
  const second = await claimAvailabilityRequestCustomerConfirmProcessing({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: CIVIC_REQUEST_ID,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ALREADY_PROCESSING");
  const stored = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  assert.equal(stored.customerConfirmProcessingStatus, "processing");
});

test("confirm execute flag defaults false when confirm and customer DM execute unset", () => {
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE;
  assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), false);
});

test("confirm execute falls back to customer DM execute when confirm env unset", () => {
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE;
  process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE = "true";
  try {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), true);
  } finally {
    delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE;
  }
});

test("executeAvailabilityCustomerConfirmBooking dry-run respects gate without booking side effects", async () => {
  const fakeDb = new FakeDb();
  await seedWaitingConfirmRequest(fakeDb, CIVIC_REQUEST_ID);
  const request = getRequestDoc(fakeDb, CIVIC_REQUEST_ID);
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fakeDb,
    businessId: BUSINESS_ID,
    request,
    messageText: "haan book kar do",
    availabilityConfirmExecute: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CONFIRM_EXECUTE_DISABLED");
  assert.equal(result.dryRun, true);
});
