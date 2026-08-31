import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { AVAILABILITY_DM_PROMPT_TYPES, containsCustomerFacingOwnerLanguage } from "../src/brain/availabilityConfirmation/index.js";
import { handleAvailabilityCustomerCloudInbound } from "../src/services/availabilityCustomerConfirmService.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";
import { buildConfirmExpiresAt } from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "owner1";
const REQUEST_ID = "avr_phase1a_001";
const CUSTOMER_PHONE = "+923001111111";
const ITEM_ID = "civic-1";

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
    async update(data) {
      const node = this._node();
      if (!node) throw new Error(`missing doc ${this.path.join("/")}`);
      node.data = { ...(node.data ?? {}), ...structuredClone(data) };
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

  function getRequestDoc(requestId) {
    return store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]?.data ?? null;
  }

  function getBookingDoc(bookingId) {
    return store.businesses[BUSINESS_ID]?.bookings?.[bookingId]?.data ?? null;
  }

  function listBookingIds() {
    return Object.keys(store.businesses[BUSINESS_ID]?.bookings ?? {});
  }

  return { db, seedAvailabilityRequest, getRequestDoc, getBookingDoc, listBookingIds };
}

function baseWaitingRequest(overrides = {}) {
  const sentAt = new Date();
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: ITEM_ID,
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 2,
    customerDmTarget: CUSTOMER_PHONE,
    customerPhone: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerNotifyMessage:
      "Honda Civic 2026 2 din ke liye available hai. Total rent 16,000 PKR hoga. Book kar du?",
    priceQuote: { status: "quoted", total: 16000, currency: "PKR", durationDays: 2 },
    sourceIdentity: { participantKey: "cust-1", chatId: "Rental Leads", chatType: "group" },
    ...overrides,
  };
}

async function handleInbound(fake, messageText, sendCalls) {
  const { decideWaitingConfirmFromLegacyClassifierForTests,
  composeWaitingConfirmExecutionReplyForTests } = await import(
    "./helpers/waitingConfirmBrainTestDouble.mjs"
  );
  return handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText,
    messageId: `in-${sendCalls.length + 1}`,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests: composeWaitingConfirmExecutionReplyForTests,
  });
}

function assertNoOwnerLanguage(sendCalls) {
  for (const [, reply] of sendCalls) {
    assert.equal(containsCustomerFacingOwnerLanguage(String(reply)), false);
  }
}

test("price then Kar doon prompt then ok creates booking once", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];

  const price = await handleInbound(fake, "rent kitna ho ga?", sendCalls);
  assert.equal(price.action, "price");
  assert.match(sendCalls[0][1], /16,000 PKR/);
  assert.equal(fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus, "waiting_confirm");

  const confirm = await handleInbound(fake, "ok", sendCalls);
  assert.equal(confirm.action, "confirmed_booking");
  const stored = fake.getRequestDoc(REQUEST_ID);
  assert.equal(stored.customerConfirmationStatus, "confirmed");
  assert.ok(stored.linkedBookingId);
  assertNoOwnerLanguage(sendCalls);
});

test("price-only context then ok asks Kar doon without booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
      lastCustomerDmOutboundPreview: "Honda Civic 2026 2 din ka rent 16,000 PKR hoga.",
      lastCustomerDmPromptAt: new Date(),
      lastCustomerDmOutboundAt: new Date(),
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "ok", sendCalls);
  assert.equal(result.action, "acknowledge");
  assert.match(sendCalls[0][1], /Confirm karna ho to bata dein/i);
  const stored = fake.getRequestDoc(REQUEST_ID);
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.linkedBookingId, undefined);
});

test("yes after Book kar du prompt creates booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      lastCustomerNotifyMessage:
        "Honda Civic 2026 2 din ke liye available hai. Book kar du?",
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "yes", sendCalls);
  assert.equal(result.action, "confirmed_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("ji after Kar doon prompt creates booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
      lastCustomerDmOutboundPreview: "Honda Civic 2026 2 din ka rent 16,000 PKR hoga. Kar doon?",
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "ji", sendCalls);
  assert.equal(result.action, "confirmed_booking");
});

test("ok pickup kahan se hogi does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "ok pickup kahan se hogi?", sendCalls);
  assert.equal(result.action, "question");
  assert.match(sendCalls[0][1], /confirmation karni hogi|pickup|Confirm karna ho to bata dein/i);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("detail question does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest({ itemLabel: "Kia Stonic White Color" }));
  const sendCalls = [];
  const result = await handleInbound(fake, "color konsa hai?", sendCalls);
  assert.equal(result.action, "question");
  assert.match(sendCalls[0][1], /White Color|white colour/i);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("corolla color question answers from itemLabel parentheses", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      itemLabel: "Toyota corolla (Metallic Grey)",
      priceQuote: { status: "quoted", total: 10000, currency: "PKR", durationDays: 2, dailyRate: 5000 },
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "Corolla ka color kon sa hai?", sendCalls);
  assert.equal(result.action, "question");
  assert.match(sendCalls[0][1], /Metallic Grey/i);
  assert.equal(fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus, "waiting_confirm");
});

test("corolla total rent answers from stored priceQuote", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      itemLabel: "Toyota corolla (Metallic Grey)",
      priceQuote: { status: "quoted", total: 10000, currency: "PKR", durationDays: 2, dailyRate: 5000 },
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "total rent kitna hai?", sendCalls);
  assert.equal(result.action, "price");
  assert.match(sendCalls[0][1], /10,000 PKR/i);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("corolla per-day rent answers from stored priceQuote", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      itemLabel: "Toyota corolla (Metallic Grey)",
      priceQuote: { status: "quoted", total: 10000, currency: "PKR", durationDays: 2, dailyRate: 5000 },
    })
  );
  const sendCalls = [];
  const result = await handleInbound(fake, "per day kitna hai?", sendCalls);
  assert.equal(result.action, "price");
  assert.match(sendCalls[0][1], /5,000 PKR/i);
});

test("image question does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest({ itemLabel: "Kia Stonic White Color" }));
  const sendCalls = [];
  const result = await handleInbound(fake, "pictures?", sendCalls);
  assert.equal(result.action, "question");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("logistics question does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "delivery possible hai?", sendCalls);
  assert.equal(result.action, "question");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("duration change does not create booking for 3 din ke liye kar do", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest({ requestedDuration: 5 }));
  const sendCalls = [];
  const result = await handleInbound(fake, "3 din ke liye kar do", sendCalls);
  assert.equal(result.action, "change_duration");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("item change does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "Civic chahiye instead", sendCalls);
  assert.equal(result.action, "change_car");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("unrelated message does not create booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest({ itemLabel: "Kia Stonic", requestedDuration: 5 }));
  const sendCalls = [];
  const result = await handleInbound(fake, "hello", sendCalls);
  assert.equal(result.action, "unclear");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("change duration does not book and avoids owner mention", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "2 din ki jagah 3 din kar do", sendCalls);
  assert.equal(result.action, "change_duration");
  assert.match(sendCalls[0][1], /3 din ke liye availability dobara (check|confirm) karni hogi/i);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assertNoOwnerLanguage(sendCalls);
});

test("change car does not book and avoids owner mention", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "Civic ki jagah Corolla kar do", sendCalls);
  assert.equal(result.action, "change_car");
  assert.match(sendCalls[0][1], /separate availability confirm karni hogi/);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assertNoOwnerLanguage(sendCalls);
});

test("decline marks request declined with natural reply", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleInbound(fake, "nahi chahiye", sendCalls);
  assert.equal(result.action, "declined");
  assert.match(sendCalls[0][1], /booking proceed nahi kar raha/);
  assert.equal(fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus, "declined");
});

test("duplicate confirmation does not create second booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    })
  );
  const sendCalls = [];
  const first = await handleInbound(fake, "yes", sendCalls);
  assert.equal(first.action, "confirmed_booking");
  const bookingId = fake.getRequestDoc(REQUEST_ID).linkedBookingId;

  const second = await handleInbound(fake, "yes", sendCalls);
  assert.notEqual(second.action, "confirmed_booking");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, bookingId);
});

test("3B booking D: confirm_booking uses owner_approved_waiting_customer_details and DM source", async () => {
  const fake = createFakeDb();
  const notifyAt = new Date();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      sourceChatId: "leads",
      sourceTurnKey: "leads::wa::3EB0GROUP004",
      customerDmChatTitle: "Adeel malik",
      customerDmPlaywrightChatKey: "adeel-malik",
      lastCustomerNotifyAt: notifyAt,
      approvalCustomerNotificationAt: notifyAt,
      lastCustomerNotifyMessage:
        "Honda Civic 2026 2 din ke liye available hai. Book kar du?",
    })
  );
  const sendCalls = [];
  const dmMessageId = "3EB0DM_CONFIRM_001";
  const {
    decideWaitingConfirmFromLegacyClassifierForTests,
    composeWaitingConfirmExecutionReplyForTests,
  } = await import("./helpers/waitingConfirmBrainTestDouble.mjs");
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Book kar do",
    messageId: dmMessageId,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.action, "confirmed_booking");
  const stored = fake.getRequestDoc(REQUEST_ID);
  assert.ok(stored.linkedBookingId);
  const booking = fake.getBookingDoc(stored.linkedBookingId);
  assert.ok(booking);
  assert.equal(booking.approvalStage, "owner_approved_waiting_customer_details");
  assert.notEqual(booking.approvalStage, "pending_owner_approval");
  assert.equal(booking.status, "approved");
  assert.notEqual(booking.status, "pending_approval");
  assert.equal(booking.availabilityRequestId, REQUEST_ID);
  assert.equal(booking.sourceGroupName, "leads");
  assert.equal(booking.sourcePlaywrightChatKey, "leads");
  assert.equal(booking.playwrightChatKey, "adeel-malik");
  assert.equal(booking.messageId, dmMessageId);
  assert.equal(booking.customerConfirmationMessageId, dmMessageId);
  assert.equal(booking.sourceMessage, "Book kar do");
  assert.equal(booking.sourceText, "Book kar do");
  assert.equal(booking.customerConfirmationTextPreview, "Book kar do");
  assert.equal(booking.sourceTurnKey, `adeel-malik::wa::${dmMessageId}`);
  assert.equal(booking.sourceMessageId, dmMessageId);
  assert.equal(booking.originalUserMessageText, "");
  assert.notEqual(booking.originalUserMessageText, "Book kar do");
  assert.equal(booking.customerDmPlaywrightChatKey, "adeel-malik");
});

const GROUP_REQUEST_TEXT = "Civic 2 din k liye chahiye";
const CLOUD_CONFIRM_TEXT = "Kar do";
const GROUP_ROW_KEY = "real:3EB0BCEDD4FB536A3B0AA2#1";
const GROUP_SOURCE_TURN_KEY = "leads::wa::3EB0BCEDD4FB536A3B0AA2";
const CLOUD_CONFIRM_WAMID = "wamid.HBgMOTA1NDQzODI5OTkwFQIAEhgTESTCONFIRM001";

function seedGroupOriginWaitingRequest(fake, extra = {}) {
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      sourceChatId: "leads",
      sourceTurnKey: GROUP_SOURCE_TURN_KEY,
      customerDmChatTitle: "Adeel malik",
      customerDmPlaywrightChatKey: "adeel-malik",
      sourceIdentity: {
        participantKey: "cust-1",
        chatId: "leads",
        chatType: "group",
        sourceRowKey: GROUP_ROW_KEY,
        sourceTurnKey: GROUP_SOURCE_TURN_KEY,
        sourceTextPreview: GROUP_REQUEST_TEXT,
      },
      ...extra,
    })
  );
}

async function confirmCloudKarDo(fake, messageId = CLOUD_CONFIRM_WAMID) {
  const sendCalls = [];
  const {
    decideWaitingConfirmFromLegacyClassifierForTests,
    composeWaitingConfirmExecutionReplyForTests,
  } = await import("./helpers/waitingConfirmBrainTestDouble.mjs");
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: CLOUD_CONFIRM_TEXT,
    messageId,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  return { result, sendCalls };
}

function assertCloudConfirmFieldsUnchanged(booking, messageId = CLOUD_CONFIRM_WAMID) {
  assert.equal(booking.sourceTurnKey, `adeel-malik::wa::${messageId}`);
  assert.equal(booking.sourceMessageId, messageId);
  assert.equal(booking.messageId, messageId);
  assert.equal(booking.sourceText, CLOUD_CONFIRM_TEXT);
  assert.equal(booking.sourceMessage, CLOUD_CONFIRM_TEXT);
  assert.equal(booking.customerConfirmationMessageId, messageId);
  assert.equal(booking.customerConfirmationTextPreview, CLOUD_CONFIRM_TEXT);
}

function locatorExpectedGroupText(booking) {
  const identity =
    booking?.sourceIdentity && typeof booking.sourceIdentity === "object"
      ? booking.sourceIdentity
      : {};
  return (
    String(identity.sourceTextPreview ?? "").trim() ||
    String(booking?.originalUserMessageText ?? "").trim() ||
    null
  );
}

function pollerReplyPrivateSourceText(booking) {
  const identity =
    booking?.sourceIdentity && typeof booking.sourceIdentity === "object"
      ? booking.sourceIdentity
      : {};
  return (
    String(
      booking?.originalUserMessageText ?? booking?.sourceText ?? identity.sourceTextPreview ?? ""
    ).trim() || null
  );
}

test("AVR Cloud confirm stores Group originalUserMessageText not Kar do", async () => {
  const fake = createFakeDb();
  seedGroupOriginWaitingRequest(fake);
  const { result } = await confirmCloudKarDo(fake);
  assert.equal(result.action, "confirmed_booking");
  const stored = fake.getRequestDoc(REQUEST_ID);
  const booking = fake.getBookingDoc(stored.linkedBookingId);
  assert.ok(booking);

  assertCloudConfirmFieldsUnchanged(booking);
  assert.equal(booking.originalUserMessageText, GROUP_REQUEST_TEXT);
  assert.notEqual(booking.originalUserMessageText, CLOUD_CONFIRM_TEXT);
  assert.equal(booking.originalMessageRowKey, GROUP_ROW_KEY);
  assert.equal(booking.sourceRowKey, GROUP_ROW_KEY);
  assert.equal(booking.sourcePlaywrightChatKey, "leads");
  assert.equal(booking.sourceGroupName, "leads");
  assert.equal(booking.originalAvailabilityRequestSourceTurnKey, GROUP_SOURCE_TURN_KEY);
  assert.equal(booking.availabilityRequestId, REQUEST_ID);
  assert.equal(booking.status, "approved");
  assert.equal(booking.approvalStage, "owner_approved_waiting_customer_details");
  assert.equal(booking.sourceIdentity?.sourceTextPreview, GROUP_REQUEST_TEXT);
  assert.notEqual(booking.sourceIdentity?.sourceTextPreview, CLOUD_CONFIRM_TEXT);
  assert.equal(locatorExpectedGroupText(booking), GROUP_REQUEST_TEXT);
  assert.equal(pollerReplyPrivateSourceText(booking), GROUP_REQUEST_TEXT);
  assert.notEqual(pollerReplyPrivateSourceText(booking), CLOUD_CONFIRM_TEXT);
});

test("AVR Cloud confirm uses request.sourceTextPreview when identity preview is absent", async () => {
  const fake = createFakeDb();
  seedGroupOriginWaitingRequest(fake, {
    sourceTextPreview: GROUP_REQUEST_TEXT,
    sourceIdentity: {
      participantKey: "cust-1",
      chatId: "leads",
      chatType: "group",
      sourceRowKey: GROUP_ROW_KEY,
      sourceTurnKey: GROUP_SOURCE_TURN_KEY,
    },
  });
  const { result } = await confirmCloudKarDo(fake);
  assert.equal(result.action, "confirmed_booking");
  const booking = fake.getBookingDoc(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assertCloudConfirmFieldsUnchanged(booking);
  assert.equal(booking.originalUserMessageText, GROUP_REQUEST_TEXT);
  assert.notEqual(booking.originalUserMessageText, CLOUD_CONFIRM_TEXT);
  assert.equal(booking.approvalStage, "owner_approved_waiting_customer_details");
});

test("AVR Cloud confirm leaves originalUserMessageText empty when Group preview is missing", async () => {
  const fake = createFakeDb();
  seedGroupOriginWaitingRequest(fake, {
    sourceIdentity: {
      participantKey: "cust-1",
      chatId: "leads",
      chatType: "group",
      sourceRowKey: GROUP_ROW_KEY,
      sourceTurnKey: GROUP_SOURCE_TURN_KEY,
    },
  });
  const { result } = await confirmCloudKarDo(fake);
  assert.equal(result.action, "confirmed_booking");
  const booking = fake.getBookingDoc(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assertCloudConfirmFieldsUnchanged(booking);
  assert.equal(booking.originalUserMessageText, "");
  assert.notEqual(booking.originalUserMessageText, CLOUD_CONFIRM_TEXT);
  assert.equal(booking.sourceIdentity?.sourceTextPreview ?? null, null);
  assert.notEqual(booking.sourceIdentity?.sourceTextPreview, CLOUD_CONFIRM_TEXT);
  assert.equal(locatorExpectedGroupText(booking), null);
  assert.equal(pollerReplyPrivateSourceText(booking), null);
  assert.notEqual(pollerReplyPrivateSourceText(booking), CLOUD_CONFIRM_TEXT);
  assert.equal(booking.approvalStage, "owner_approved_waiting_customer_details");
  assert.equal(booking.status, "approved");
});

test("same Cloud sourceTurnKey does not create a second booking", async () => {
  const fake = createFakeDb();
  seedGroupOriginWaitingRequest(fake);
  const { result } = await confirmCloudKarDo(fake);
  assert.equal(result.action, "confirmed_booking");
  const firstId = fake.getRequestDoc(REQUEST_ID).linkedBookingId;
  const first = fake.getBookingDoc(firstId);
  assert.equal(fake.listBookingIds().length, 1);

  const second = await executeCreateBooking({
    payload: {
      itemId: ITEM_ID,
      itemName: "Honda Civic 2026",
      durationDays: 2,
      sourceMessage: CLOUD_CONFIRM_TEXT,
      sourceTurnKey: first.sourceTurnKey,
      sourceMessageId: CLOUD_CONFIRM_WAMID,
    },
    executionContext: {
      businessId: BUSINESS_ID,
      traceId: "confirm-source-turn-idempotency",
      dbOverride: fake.db,
    },
  });

  assert.equal(second.ok, true);
  assert.equal(second.booking?.id, firstId);
  assert.equal(second.booking?.duplicateSourceTurn, true);
  assert.equal(fake.listBookingIds().length, 1);
  const stored = fake.getBookingDoc(firstId);
  assertCloudConfirmFieldsUnchanged(stored);
  assert.equal(stored.originalUserMessageText, GROUP_REQUEST_TEXT);
  assert.equal(stored.approvalStage, "owner_approved_waiting_customer_details");
});
