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
  WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN,
  WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
  parseWaitingConfirmDmDecision,
  evaluateWaitingConfirmDmBrainConfirmGuard,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const {
  handleAvailabilityCustomerCloudInbound,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUSINESS_ID = "owner-wc-brain-1";
const REQUEST_ID = "avr_wc_brain_001";
const CUSTOMER_PHONE = "+923009998877";
const ITEM_ID = "civic-wc-1";

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

function injectDecision(overrides = {}) {
  return async (turnContext) => ({
    ok: true,
    source: "test_double",
    lane: WAITING_CONFIRM_DM_LANE,
    turnContext,
    decision: {
      conversationStage: "booking_offer",
      customerIntent: "unclear",
      situation: "awaiting_confirm",
      customerIsConfirmingBooking: false,
      customerIsAskingQuestion: false,
      customerIsDeclining: false,
      customerWantsChange: false,
      shouldReply: true,
      customerReply: "Theek hai.",
      action: "reply",
      confidence: 0.8,
      requiredExecutor: "whatsapp_cloud_dm",
      ...overrides,
    },
  });
}

function validBrainConfirmDecision(overrides = {}) {
  return {
    action: "confirm_booking",
    customerIsConfirmingBooking: true,
    customerIsAskingQuestion: false,
    shouldReply: false,
    customerReply: "",
    confidence: 0.92,
    requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
    ...overrides,
  };
}

async function handleBrainInbound(fake, messageText, opts = {}) {
  const sendCalls = opts.sendCalls || [];
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
    __decideCustomerTurnForTests:
      opts.decideFn || injectDecision(opts.decision || {}),
  });
  return { result, sendCalls };
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

test("flag OFF: kar do still books through existing gate", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "kar do",
    messageId: "off-confirm-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __waitingConfirmDmBrainEnabled: false,
  });
  assert.equal(result.action, "confirmed_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assert.equal(result.waitingConfirmDmBrain, undefined);
});

test("flag OFF: price Q&A unchanged", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "rent kitna ho ga?",
    messageId: "off-price-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __waitingConfirmDmBrainEnabled: false,
  });
  assert.equal(result.action, "price");
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

test("flag ON: Brain receives full context including history", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  let seen = null;
  const decideFn = async (turnContext) => {
    seen = turnContext;
    return injectDecision({
      action: "reply",
      customerReply: "Theek hai, bata dein.",
    })(turnContext);
  };
  const history = "Emily: Book kar du?\nCustomer: advance kitna?";
  await handleBrainInbound(fake, "thanks", {
    conversationHistory: history,
    decideFn,
  });
  assert.ok(seen);
  assert.equal(seen.lane, WAITING_CONFIRM_DM_LANE);
  assert.match(String(seen.recentDialogue), /advance kitna/);
  assert.match(String(seen.lastEmilyMessage), /Book kar du/);
  assert.equal(seen.facts?.quotedPrice?.total, 16000);
  assert.equal(seen.facts?.availabilityRequest?.itemLabel, "Honda Civic 2026");
  assert.equal(seen.facts?.availabilityRequest?.requestedDuration, 2);
});

test("flag ON: natural confirm routes to confirm executor", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "done done", {
    decision: validBrainConfirmDecision(),
  });
  assert.equal(result.action, "confirmed_booking");
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.equal(result.actionType, "confirm_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assert.equal(result.pamissCreated, false);
  assert.equal(result.ownerNotified, false);
});

test("flag ON: kar do still books via Brain confirm + executor", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "kar do", {
    decision: validBrainConfirmDecision({ confidence: 0.95 }),
  });
  assert.equal(result.action, "confirmed_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("flag ON: duplicate confirm does not create second booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const confirmDecision = validBrainConfirmDecision({ confidence: 0.95 });
  const first = await handleBrainInbound(fake, "haan", {
    messageId: "dup-a",
    decision: confirmDecision,
  });
  assert.equal(first.result.action, "confirmed_booking");
  const bookingId = fake.getRequestDoc(REQUEST_ID).linkedBookingId;
  const second = await handleBrainInbound(fake, "haan", {
    messageId: "dup-b",
    decision: confirmDecision,
  });
  assert.notEqual(second.result.action, "confirmed_booking");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, bookingId);
});

test("flag ON: confirm_booking for pure question does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "advance kitna hoga?", {
    decision: validBrainConfirmDecision({
      customerIsAskingQuestion: true,
      customerReply: "Advance abhi confirm nahi.",
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.confirmGuardFailed, true);
  assert.ok(result.confirmGuardReasons?.includes("ASKING_QUESTION"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(result.pamissCreated, false);
  assert.equal(result.ownerNotified, false);
});

test("flag ON: confirm_booking without confirming flag does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "chalo", {
    decision: validBrainConfirmDecision({
      customerIsConfirmingBooking: false,
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.confirmGuardFailed, true);
  assert.ok(result.confirmGuardReasons?.includes("CONFIRMING_FLAG_FALSE"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("flag ON: confirm_booking with wrong requiredExecutor does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "chalo", {
    decision: validBrainConfirmDecision({
      requiredExecutor: "whatsapp_cloud_dm",
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.confirmGuardFailed, true);
  assert.ok(result.confirmGuardReasons?.includes("REQUIRED_EXECUTOR_MISMATCH"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("flag ON: confirm_booking with low confidence does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "chalo", {
    decision: validBrainConfirmDecision({
      confidence: WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN - 0.2,
    }),
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.confirmGuardFailed, true);
  assert.ok(result.confirmGuardReasons?.includes("CONFIDENCE_TOO_LOW"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("flag ON: confirm_booking without active booking prompt does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingRequest({
      lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
      lastCustomerDmOutboundPreview:
        "Honda Civic 2026 2 din ka rent 16,000 PKR hoga.",
      lastCustomerNotifyMessage:
        "Honda Civic 2026 2 din ka rent 16,000 PKR hoga.",
    })
  );
  const { result } = await handleBrainInbound(fake, "chalo", {
    decision: validBrainConfirmDecision(),
  });
  assert.equal(result.action, "clarify");
  assert.equal(result.confirmGuardFailed, true);
  assert.ok(result.confirmGuardReasons?.includes("BOOKING_PROMPT_NOT_ACTIVE"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
});

test("flag ON: Q&A reply clears stale booking prompt; wrong confirm does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).lastCustomerDmPromptType,
    AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION
  );

  const qa = await handleBrainInbound(fake, "advance kitna hoga?", {
    messageId: "stale-qa-1",
    decision: {
      action: "reply",
      customerIsAskingQuestion: true,
      customerReply: "Advance amount abhi confirm nahi hai.",
      asksForBookingConfirmation: false,
      outboundPromptType: "general_info",
      confidence: 0.9,
    },
  });
  assert.equal(qa.result.action, "reply");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).lastCustomerDmPromptType,
    AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);

  // Brain incorrectly returns a high-confidence confirm after Q&A.
  const bad = await handleBrainInbound(fake, "ok", {
    messageId: "stale-qa-2",
    conversationHistory:
      "Emily: Book kar du?\nCustomer: advance kitna?\nEmily: Advance confirm nahi.",
    decision: validBrainConfirmDecision({ confidence: 0.99 }),
  });
  assert.equal(bad.result.action, "clarify");
  assert.equal(bad.result.confirmGuardFailed, true);
  assert.ok(bad.result.confirmGuardReasons?.includes("BOOKING_PROMPT_NOT_ACTIVE"));
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(bad.result.pamissCreated, false);
  assert.equal(bad.result.ownerNotified, false);
});

test("flag ON: explicit asksForBookingConfirmation re-arms confirm; later confirm books", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());

  const qa = await handleBrainInbound(fake, "driver milega?", {
    messageId: "rearm-1",
    decision: {
      action: "reply",
      customerIsAskingQuestion: true,
      customerReply:
        "Driver abhi confirm nahi. Book confirm karna ho to bata dein.",
      asksForBookingConfirmation: true,
      confidence: 0.9,
    },
  });
  assert.equal(qa.result.action, "reply");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).lastCustomerDmPromptType,
    AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION
  );

  const confirm = await handleBrainInbound(fake, "haan", {
    messageId: "rearm-2",
    decision: validBrainConfirmDecision(),
  });
  assert.equal(confirm.result.action, "confirmed_booking");
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
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
    decision: validBrainConfirmDecision(),
    turnContext,
  });
  assert.equal(ok.ok, true);
});

test("flag ON: ambiguous ack after Q&A does not book", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "ok", {
    conversationHistory: "Emily: Advance confirm nahi. Customer: ok",
    decision: {
      action: "clarify",
      customerReply: "Book confirm karna hai? Bata dein.",
      customerIsConfirmingBooking: false,
      confidence: 0.4,
    },
  });
  assert.notEqual(result.action, "confirmed_booking");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("flag ON: questions do not book; missing facts honest; no pamiss/owner", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result, sendCalls } = await handleBrainInbound(
    fake,
    "advance kitna hoga?",
    {
      decision: {
        action: "reply",
        customerIsAskingQuestion: true,
        customerReply:
          "Advance amount abhi confirm nahi hai. Book karna ho to bata dein.",
      },
    }
  );
  assert.equal(result.action, "reply");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.match(String(sendCalls[0][1]), /confirm nahi/i);
  assert.doesNotMatch(String(sendCalls[0][1]), /\b\d{3,}\s*%|\b50%|\badvance\s+\d/i);
  assert.equal(result.pamissCreated, false);
  assert.equal(result.ownerNotified, false);
  assert.equal(fake.pamissCount(), 0);
});

test("flag ON: negotiation does not invent discount", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result, sendCalls } = await handleBrainInbound(
    fake,
    "price kam ho sakta hai?",
    {
      decision: {
        action: "reply",
        customerReply:
          "Quoted rent 16,000 PKR hai. Discount abhi confirm nahi hai.",
      },
    }
  );
  assert.equal(result.action, "reply");
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.doesNotMatch(String(sendCalls[0][1]), /15,?000|discount mil|kam kar diya/i);
  assert.match(String(sendCalls[0][1]), /16,?000/);
});

test("flag ON: casual social no after Q&A does not decline", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "no", {
    conversationHistory:
      "Emily: Driver confirm nahi. Customer: ok thanks. Emily: Aur kuch?",
    decision: {
      action: "silence",
      shouldReply: false,
      customerReply: "",
      customerIsDeclining: false,
    },
  });
  assert.equal(result.action, "silence");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
});

test("flag ON: real decline uses safe decline path", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const { result } = await handleBrainInbound(fake, "nahi chahiye", {
    decision: {
      action: "decline_request",
      customerIsDeclining: true,
      customerReply: "Theek hai, cancel kar diya.",
      requiredExecutor: "decline_request_executor",
    },
  });
  assert.equal(result.action, "declined");
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "declined"
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("flag ON: change request does not mutate unsafely", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const before = { ...fake.getRequestDoc(REQUEST_ID) };
  const { result, sendCalls } = await handleBrainInbound(fake, "change car", {
    decision: {
      action: "change_request",
      customerWantsChange: true,
      customerReply: "Is car ke liye separate availability confirm karni hogi.",
      requiredExecutor: "protected_change_reply_executor",
    },
  });
  assert.equal(result.action, "change_request");
  const after = fake.getRequestDoc(REQUEST_ID);
  assert.equal(after.customerConfirmationStatus, before.customerConfirmationStatus);
  assert.equal(after.status, before.status);
  assert.equal(after.itemId, before.itemId);
  assert.equal(after.linkedBookingId, undefined);
  assert.match(String(sendCalls[0][1]), /separate availability/i);
});

test("decideCustomerTurn waiting_confirm_dm uses injected OpenAI double", async () => {
  const turnContext = packWaitingConfirmDmTurnContext({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "chalo",
    request: baseWaitingRequest(),
  });
  turnContext.__chatCompletionsCreateForTests = async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            action: "confirm_booking",
            customerIsConfirmingBooking: true,
            shouldReply: false,
            customerReply: "",
            confidence: 0.9,
            reason: "natural_confirm",
          }),
        },
      },
    ],
  });
  const out = await decideCustomerTurn(turnContext);
  assert.equal(out.lane, WAITING_CONFIRM_DM_LANE);
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
});

test("buffer only gains conversationHistory param pass-through (no routing reorder)", () => {
  const src = readFileSync(
    join(ROOT, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  const confirmCall = src.indexOf("tryCloudConfirmFn({");
  assert.ok(confirmCall > 0);
  const snippet = src.slice(confirmCall, confirmCall + 280);
  assert.match(snippet, /conversationHistory/);
  // Runtime ownership order anchors (declarations, not imports).
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
