import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NODE_ENV = "test";

const {
  AVAILABILITY_DM_PROMPT_TYPES,
} = await import("../src/brain/availabilityConfirmation/index.js");
const {
  isEmilyWaitingConfirmDmBrainEnabled,
} = await import("../src/brain/config/liveFeatureFlags.js");
const {
  decideCustomerTurn,
  CUSTOMER_TURN_LANES,
} = await import("../src/brain/decisions/decideCustomerTurn.js");
const {
  packWaitingConfirmDmTurnContext,
  WAITING_CONFIRM_DM_LANE,
  WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
  WAITING_CONFIRM_DM_ALLOWED_ACTIONS,
  WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
  parseWaitingConfirmDmDecision,
  evaluateWaitingConfirmDmBrainConfirmGuard,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const {
  handleAvailabilityCustomerCloudInbound,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);
const {
  buildAvailabilityConfirmSuccessReply,
} = await import("../src/services/availabilityMessageBuilder.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUSINESS_ID = "owner-wc-brain-1";
const REQUEST_ID = "avr_wc_brain_001";
const CUSTOMER_PHONE = "+923009998877";
const ITEM_ID = "civic-wc-1";
const EXECUTOR_SUCCESS_REPLY = buildAvailabilityConfirmSuccessReply();

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
      paMissingInfoRequests: {},
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
    async update(data) {
      const node = this._node();
      if (!node) throw new Error(`missing doc ${this.path.join("/")}`);
      node.data = { ...(node?.data ?? {}), ...structuredClone(data) };
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
      db
        .collection("businesses")
        .doc(BUSINESS_ID)
        .collection("availabilityRequests")
        .doc(requestId),
      data
    );
  }

  function getRequestDoc(requestId) {
    return (
      store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]?.data ??
      null
    );
  }

  function pamissCount() {
    return Object.keys(
      store.businesses[BUSINESS_ID]?.paMissingInfoRequests ?? {}
    ).length;
  }

  return { db, store, seedAvailabilityRequest, getRequestDoc, pamissCount };
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
    lastCustomerDmOutboundPreview:
      "Honda Civic 2026 2 din ke liye available hai. Total rent 16,000 PKR hoga. Book kar du?",
    lastCustomerNotifyMessage:
      "Honda Civic 2026 2 din ke liye available hai. Total rent 16,000 PKR hoga. Book kar du?",
    priceQuote: {
      status: "quoted",
      total: 16000,
      currency: "PKR",
      durationDays: 2,
      dailyRate: 8000,
    },
    sourceIdentity: {
      participantKey: "cust-wc-1",
      chatId: "Rental Leads",
      chatType: "group",
    },
    ...overrides,
  };
}

function baseModelFields(overrides = {}) {
  return {
    conversationStage: "booking_offer",
    customerMood: null,
    customerIntent: "unclear",
    situation: "awaiting_confirm",
    customerIsConfirmingBooking: false,
    customerIsAskingQuestion: false,
    customerIsDeclining: false,
    customerWantsChange: false,
    requestedInfoType: null,
    shouldReply: true,
    customerReply: "",
    action: "reply",
    confidence: 0.9,
    safetyNotes: null,
    reason: "test",
    asksForBookingConfirmation: false,
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    ...overrides,
  };
}

/** OpenAI transport double only — production parser/lane/service must run. */
function openaiCreateFromPayload(payload, counter = null) {
  return async () => {
    if (counter) counter.calls += 1;
    return {
      choices: [{ message: { content: JSON.stringify(payload) } }],
    };
  };
}

async function handleBrainInbound(fake, messageText, opts = {}) {
  const sendCalls = opts.sendCalls || [];
  const openaiCounter = opts.openaiCounter || { calls: 0 };
  const createFn =
    opts.openaiCreate ||
    openaiCreateFromPayload(
      opts.openaiPayload || baseModelFields(),
      openaiCounter
    );
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText,
    messageId: opts.messageId || `in-${sendCalls.length + 1}-${Date.now()}`,
    conversationHistory: opts.conversationHistory ?? null,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __waitingConfirmDmBrainEnabled: opts.brainEnabled !== false,
    __catalogRowForTests: {
      id: "civic-1",
      name: "Honda Civic 2026",
      displayLabel: "Honda Civic 2026",
      dailyRate: 8000,
    },
    __chatCompletionsCreateForTests: createFn,
  });
  return { result, sendCalls, openaiCounter };
}

test("feature flag defaults OFF", () => {
  const prev = process.env.EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED;
  delete process.env.EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED;
  assert.equal(isEmilyWaitingConfirmDmBrainEnabled(), false);
  if (prev !== undefined) {
    process.env.EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED = prev;
  }
});

test("CUSTOMER_TURN_LANES includes waiting_confirm_dm", () => {
  assert.ok(CUSTOMER_TURN_LANES.includes(WAITING_CONFIRM_DM_LANE));
});

test("WAITING_CONFIRM_DM_ALLOWED_ACTIONS matches lane contract", () => {
  for (const action of [
    "reply",
    "silence",
    "clarify",
    "confirm_booking",
    "decline_request",
    "change_request",
    "none",
  ]) {
    assert.equal(WAITING_CONFIRM_DM_ALLOWED_ACTIONS.has(action), true);
  }
  assert.equal(WAITING_CONFIRM_DM_ALLOWED_ACTIONS.has("launch_missiles"), false);
});

test("PR1: waiting_confirm always uses decideCustomerTurn (classifier not final)", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  let decideCalls = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "kar do",
    messageId: "pr1-confirm-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: async (turnContext) => {
      decideCalls += 1;
      assert.equal(turnContext?.continuation?.type, "waiting_confirm");
      assert.equal(turnContext?.continuation?.safeToOwn, true);
      return {
        ok: true,
        decision: {
          ...baseModelFields({
            action: "confirm_booking",
            customerIsConfirmingBooking: true,
            customerReply: "Confirm mil gaya, request aage barhati hun.",
            confidence: 0.95,
            requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
          }),
        },
        source: "test",
        lane: WAITING_CONFIRM_DM_LANE,
      };
    },
  });
  assert.equal(decideCalls, 1);
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.equal(result.action, "confirmed_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("PR1: price Q&A via decideCustomerTurn (not classifier path)", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "rent kitna ho ga?",
    messageId: "pr1-price-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __decideCustomerTurnForTests: async () => ({
      ok: true,
      decision: baseModelFields({
        action: "reply",
        customerIsAskingQuestion: true,
        customerReply: "2 din ka rent 16,000 PKR hoga.",
        customerIntent: "ask_price",
      }),
      source: "test",
      lane: WAITING_CONFIRM_DM_LANE,
    }),
  });
  assert.equal(result.action, "reply");
  assert.match(String(sendCalls[0][1]), /16,000 PKR/);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
});

test("TurnContext packer includes history, last Emily, AVR, price", () => {
  const ctx = packWaitingConfirmDmTurnContext({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "done",
    messageId: "m1",
    conversationHistory: "Emily: Book kar du?\nCustomer: advance?",
    request: baseWaitingRequest(),
  });
  assert.equal(ctx.lane, WAITING_CONFIRM_DM_LANE);
  assert.equal(ctx.channel, "whatsapp_cloud");
  assert.equal(ctx.chatType, "dm");
  assert.match(String(ctx.lastEmilyMessage), /Book kar du/);
  assert.equal(ctx.lastCustomerDmPromptType, "booking_confirmation_prompt");
  assert.equal(ctx.activeAvailabilityRequest?.status, "approved");
  assert.equal(ctx.facts?.quotedPrice?.total, 16000);
  assert.match(String(ctx.recentDialogue), /advance/);
  assert.equal(ctx.safetyPolicy?.noPamissInStep4, true);
  assert.equal(ctx.safetyPolicy?.noOwnerNotificationInStep4, true);
  assert.ok(ctx.allowedExecutors.includes("confirm_booking_executor"));
});

test("authentic: confirm books once and sends only Brain customerReply", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const brainReply = "Confirm mil gaya, request aage barhati hun.";
  const openaiCounter = { calls: 0 };
  const { result, sendCalls } = await handleBrainInbound(
    fake,
    "haan book kar do",
    {
      messageId: "auth-confirm-1",
      openaiCounter,
      openaiPayload: baseModelFields({
        customerIntent: "confirm",
        customerIsConfirmingBooking: true,
        shouldReply: true,
        customerReply: brainReply,
        action: "confirm_booking",
        confidence: 0.95,
        reason: "natural_confirm",
        replySemantics: {
          claims: ["customer_confirmation_acknowledged"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    }
  );
  assert.equal(openaiCounter.calls, 1);
  assert.equal(result.action, "confirmed_booking");
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), brainReply);
  assert.notEqual(String(sendCalls[0][1]), EXECUTOR_SUCCESS_REPLY);
  assert.notEqual(result.result?.reply, brainReply);
  assert.equal(result.result?.reply, EXECUTOR_SUCCESS_REPLY);
  assert.equal(result.pamissCreated, false);
  assert.equal(result.ownerNotified, false);
});

test("authentic: decline mutates once and sends Brain reply", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const brainReply = "Theek hai, ye offer skip kar dete hain.";
  const openaiCounter = { calls: 0 };
  const { result, sendCalls } = await handleBrainInbound(fake, "nahi chahiye", {
    messageId: "auth-decline-1",
    openaiCounter,
    openaiPayload: baseModelFields({
      customerIntent: "decline",
      customerIsDeclining: true,
      shouldReply: true,
      customerReply: brainReply,
      action: "decline_request",
      reason: "clear_decline",
    }),
  });
  assert.equal(openaiCounter.calls, 1);
  assert.equal(result.action, "declined");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "declined"
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), brainReply);
});

test("authentic: price/scoped question replies without mutation", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const brainReply = "2 din ka total rent 16000 PKR hoga.";
  const { result, sendCalls } = await handleBrainInbound(
    fake,
    "rent kitna hoga?",
    {
      messageId: "auth-price-1",
      openaiPayload: baseModelFields({
        customerIntent: "ask_fact",
        customerIsAskingQuestion: true,
        requestedInfoType: "price",
        shouldReply: true,
        customerReply: brainReply,
        action: "reply",
        reason: "price_question",
        replySemantics: {
          claims: ["quotation_verified"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    }
  );
  assert.equal(result.action, "reply");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), brainReply);
  assert.doesNotMatch(String(sendCalls[0][1]), /Booking confirm ho gayi/);
});

test("authentic: change request sends Brain reply without mutation", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const before = { ...fake.getRequestDoc(REQUEST_ID) };
  const brainReply =
    "Is car ke liye alag se availability confirm karni hogi.";
  const { result, sendCalls } = await handleBrainInbound(fake, "dusri car", {
    messageId: "auth-change-1",
    openaiPayload: baseModelFields({
      customerIntent: "change",
      customerWantsChange: true,
      shouldReply: true,
      customerReply: brainReply,
      action: "change_request",
      reason: "change_car",
    }),
  });
  assert.equal(result.action, "change_request");
  const after = fake.getRequestDoc(REQUEST_ID);
  assert.equal(after.customerConfirmationStatus, before.customerConfirmationStatus);
  assert.equal(after.status, before.status);
  assert.equal(after.itemId, before.itemId);
  assert.equal(after.linkedBookingId, undefined);
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), brainReply);
});

test("authentic: unclear clarify sends Brain wording only", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const brainReply = "Main samajh nahi payi. Dobara short mein bata dein?";
  const { result, sendCalls } = await handleBrainInbound(fake, "hmm ok?", {
    messageId: "auth-unclear-1",
    openaiPayload: baseModelFields({
      conversationStage: "unclear",
      situation: "unclear",
      customerIntent: "unclear",
      shouldReply: true,
      customerReply: brainReply,
      action: "clarify",
      confidence: 0.4,
      reason: "unclear",
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), brainReply);
  assert.doesNotMatch(String(sendCalls[0][1]), /Kaunsi car book karni hai/);
});

test("authentic: invalid action fails closed — no mutation, no outbound", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const openaiCounter = { calls: 0 };
  const { result, sendCalls } = await handleBrainInbound(fake, "hello", {
    messageId: "auth-invalid-1",
    openaiCounter,
    openaiPayload: baseModelFields({
      action: "launch_missiles",
      shouldReply: true,
      customerReply: "Should never send",
      reason: "bad_action",
    }),
  });
  assert.equal(openaiCounter.calls >= 1, true);
  assert.equal(result.brainFailed, true);
  assert.equal(result.action, "silence");
  assert.equal(result.reply, null);
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
});

test("authentic: malformed JSON fails closed", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result, sendCalls } = await handleBrainInbound(fake, "haan", {
    messageId: "auth-malformed-1",
    openaiCreate: async () => ({
      choices: [{ message: { content: "not-json{{{" } }],
    }),
  });
  assert.equal(result.brainFailed, true);
  assert.equal(result.action, "silence");
  assert.equal(result.reply, null);
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("authentic: OpenAI timeout fails closed", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result, sendCalls } = await handleBrainInbound(fake, "haan", {
    messageId: "auth-timeout-1",
    openaiCreate: async () => {
      throw new Error("WAITING_CONFIRM_DM_OPENAI_TIMEOUT");
    },
  });
  assert.equal(result.brainFailed, true);
  assert.equal(result.action, "silence");
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("authentic: empty clarify reply uses lane technical fallback only", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result, sendCalls } = await handleBrainInbound(fake, "???", {
    messageId: "auth-empty-1",
    openaiPayload: baseModelFields({
      conversationStage: "unclear",
      situation: "unclear",
      shouldReply: true,
      customerReply: "",
      action: "clarify",
      confidence: 0.4,
      reason: "empty_body",
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(sendCalls.length, 1);
  assert.equal(String(sendCalls[0][1]), WAITING_CONFIRM_DM_TECHNICAL_FALLBACK);
  assert.notEqual(String(sendCalls[0][1]), EXECUTOR_SUCCESS_REPLY);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("authentic: same inbound message ID — one Brain, one booking, one outbound", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const brainReply = "Confirm mil gaya, request aage barhati hun.";
  const openaiCounter = { calls: 0 };
  const openaiPayload = baseModelFields({
    customerIntent: "confirm",
    customerIsConfirmingBooking: true,
    shouldReply: true,
    customerReply: brainReply,
    action: "confirm_booking",
    confidence: 0.95,
    reason: "natural_confirm",
    replySemantics: {
      claims: ["customer_confirmation_acknowledged"],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
  });
  const sendCalls = [];
  const first = await handleBrainInbound(fake, "haan book kar do", {
    messageId: "same-msg-1",
    sendCalls,
    openaiCounter,
    openaiPayload,
  });
  assert.equal(first.result.action, "confirmed_booking");
  assert.equal(openaiCounter.calls, 1);
  assert.equal(sendCalls.length, 1);
  const bookingId = fake.getRequestDoc(REQUEST_ID).linkedBookingId;
  assert.ok(bookingId);

  const second = await handleBrainInbound(fake, "haan book kar do", {
    messageId: "same-msg-1",
    sendCalls,
    openaiCounter,
    openaiPayload,
  });
  assert.equal(second.result.duplicate, true);
  assert.equal(openaiCounter.calls, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, bookingId);
});

test("evaluateWaitingConfirmDmBrainConfirmGuard: confirming flag independent of action", () => {
  const turnContext = packWaitingConfirmDmTurnContext({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "x",
    request: baseWaitingRequest(),
  });
  const failed = evaluateWaitingConfirmDmBrainConfirmGuard({
    decision: {
      action: "confirm_booking",
      customerIsConfirmingBooking: false,
      customerIsAskingQuestion: false,
      confidence: 0.95,
      requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
    },
    turnContext,
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.reasons.includes("CONFIRMING_FLAG_FALSE"));

  const ok = evaluateWaitingConfirmDmBrainConfirmGuard({
    decision: {
      action: "confirm_booking",
      customerIsConfirmingBooking: true,
      customerIsAskingQuestion: false,
      confidence: 0.92,
      requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
    },
    turnContext,
  });
  assert.equal(ok.ok, true);
});

test("decideCustomerTurn waiting_confirm_dm uses injected OpenAI double", async () => {
  const turnContext = packWaitingConfirmDmTurnContext({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "chalo",
    request: baseWaitingRequest(),
  });
  turnContext.__chatCompletionsCreateForTests = openaiCreateFromPayload(
    baseModelFields({
      action: "confirm_booking",
      customerIsConfirmingBooking: true,
      shouldReply: true,
      customerReply: "Confirm mil gaya, request aage barhati hun.",
      confidence: 0.9,
      reason: "natural_confirm",
      replySemantics: {
        claims: ["customer_confirmation_acknowledged"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const out = await decideCustomerTurn(turnContext);
  assert.equal(out.lane, WAITING_CONFIRM_DM_LANE);
  assert.equal(out.ok, true);
  assert.equal(out.decision.action, "confirm_booking");
  assert.equal(out.decision.requiredExecutor, "confirm_booking_executor");
});

test("parseWaitingConfirmDmDecision: confirming flag is independent of action", () => {
  const withoutFlag = parseWaitingConfirmDmDecision(
    JSON.stringify({
      action: "confirm_booking",
      customerIsConfirmingBooking: false,
      shouldReply: false,
      customerReply: "",
      confidence: 0.9,
    })
  );
  assert.equal(withoutFlag.customerIsConfirmingBooking, false);
  assert.equal(withoutFlag.action, "clarify");

  const withFlag = parseWaitingConfirmDmDecision(
    JSON.stringify({
      action: "confirm_booking",
      customerIsConfirmingBooking: true,
      shouldReply: false,
      customerReply: "",
      confidence: 0.9,
    })
  );
  assert.equal(withFlag.customerIsConfirmingBooking, true);
  assert.equal(withFlag.action, "confirm_booking");
});

test("parseWaitingConfirmDmDecision: unsupported action returns null", () => {
  const parsed = parseWaitingConfirmDmDecision(
    JSON.stringify({
      action: "launch_missiles",
      shouldReply: true,
      customerReply: "Nope",
      confidence: 0.9,
    })
  );
  assert.equal(parsed, null);
});

test("parseWaitingConfirmDmDecision: shouldReply true never leaves empty customerReply", () => {
  const parsed = parseWaitingConfirmDmDecision(
    JSON.stringify({
      action: "clarify",
      shouldReply: true,
      customerReply: "   ",
      confidence: 0.5,
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.shouldReply, true);
  assert.equal(parsed.customerReply, WAITING_CONFIRM_DM_TECHNICAL_FALLBACK);
});

test("no canned tables / topic-regex maps / pamiss / owner notify added in Step 4 files", () => {
  const files = [
    "src/brain/decisions/waitingConfirmDmLane.js",
    "src/brain/decisions/decideCustomerTurn.js",
    "src/services/availabilityCustomerConfirmService.js",
  ];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(
      src,
      /CANNED_REPLY|TOPIC_REGEX_MAP|topicReplyMap|phraseMap/i
    );
    assert.doesNotMatch(
      src,
      /createPaMissingInfo|createMissingInfoRequest|notifyOwnerPa|sendOwnerNotification|ownerNotifyStatus\s*:/
    );
  }
  const lane = readFileSync(
    join(ROOT, "src/brain/decisions/waitingConfirmDmLane.js"),
    "utf8"
  );
  assert.match(lane, /noPamissInStep4/);
  assert.match(lane, /noOwnerNotificationInStep4/);
  const confirm = readFileSync(
    join(ROOT, "src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.match(confirm, /pamissCreated:\s*false/);
  assert.match(confirm, /ownerNotified:\s*false/);
  assert.doesNotMatch(
    confirm.slice(
      confirm.indexOf("async function handleWaitingConfirmDmBrainCloudTurn"),
      confirm.indexOf("export async function handleAvailabilityCustomerCloudInbound")
    ),
    /result\.reply\s*\|\||clean\(result\.reply\)|sendCustomerDmReply\(\{[^}]*result\.reply/s
  );
});

test("buffer only gains conversationHistory param pass-through (no routing reorder)", () => {
  const src = readFileSync(
    join(ROOT, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  const confirmCall = src.indexOf("handleCloudConfirmFn({");
  assert.ok(confirmCall > 0);
  const snippet = src.slice(confirmCall, confirmCall + 280);
  assert.match(snippet, /conversationHistory/);
  const cloudIdx = src.indexOf("const canTryCloudConfirmOwnership =");
  const waitingIdx = src.indexOf(
    "const ownershipGuard = await evaluateAvailabilityWaitingConfirmOwnershipGuard"
  );
  const paOwnerIdx = src.indexOf("__tryHandlePaMissingInfoOwnerAnswerFn");
  const businessPaIdx = src.indexOf("const canTryBusinessPa =");
  assert.ok(cloudIdx > 0);
  assert.ok(waitingIdx > cloudIdx);
  assert.ok(paOwnerIdx > waitingIdx);
  assert.ok(businessPaIdx > paOwnerIdx);
});
