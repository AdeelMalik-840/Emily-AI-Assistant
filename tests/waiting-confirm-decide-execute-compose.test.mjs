/**
 * Waiting-confirm DM: decide (semantic) → execute → compose (post-exec wording).
 * Cloud + Playwright share runWaitingConfirmDmBrainTurn.
 */
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
  WAITING_CONFIRM_DM_LANE,
  WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
  WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const {
  handleAvailabilityCustomerCloudInbound,
  handleAvailabilityCustomerPlaywrightInbound,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);
const { composeWaitingConfirmExecutionReplyForTests } = await import(
  "./helpers/waitingConfirmBrainTestDouble.mjs"
);
const { composeWaitingConfirmExecutionReply } = await import(
  "../src/brain/decisions/composeWaitingConfirmExecutionReply.js"
);
const {
  validateCustomerReplyAgainstContract,
} = await import("../src/brain/guards/customerReplyGuard.js");
const {
  buildPostExecutionBookingSuccessContract,
  CUSTOMER_CLAIMS,
} = await import("../src/brain/contracts/customerReplyContract.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUSINESS_ID = "owner-wc-dec-1";
const REQUEST_ID = "avr_wc_dec_001";
const CUSTOMER_PHONE = "+923009991122";
const ITEM_ID = "civic-wc-dec";
const CATALOG_ROW = {
  id: ITEM_ID,
  name: "Honda Civic",
  displayLabel: "Honda Civic",
  dailyRate: 8000,
};

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
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

  return {
    db,
    seedAvailabilityRequest(requestId, data) {
      setDoc(
        db
          .collection("businesses")
          .doc(BUSINESS_ID)
          .collection("availabilityRequests")
          .doc(requestId),
        data
      );
    },
    getRequestDoc(requestId) {
      return (
        store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]
          ?.data ?? null
      );
    },
  };
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
    customerPhone: CUSTOMER_PHONE,
    customerDmTarget: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    customerDmTransport: "cloud_api",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerDmPromptAt: sentAt,
    lastCustomerDmOutboundAt: sentAt,
    lastCustomerNotifyMessage: "Honda Civic available. Book kar du?",
    priceQuote: {
      status: "quoted",
      total: 16000,
      currency: "PKR",
      durationDays: 2,
    },
    ...overrides,
  };
}

function confirmDecision(overrides = {}) {
  return {
    ok: true,
    decision: {
      action: "confirm_booking",
      customerReply: "",
      shouldReply: true,
      customerIsConfirmingBooking: true,
      customerIsAskingQuestion: false,
      customerIsDeclining: false,
      customerWantsChange: false,
      confidence: 0.95,
      requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
      situation: "awaiting_confirm",
      customerIntent: "confirm_booking",
      asksForBookingConfirmation: false,
      replySemantics: {
        claims: ["customer_confirmation_acknowledged"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
      ...overrides,
    },
    source: "test",
    lane: WAITING_CONFIRM_DM_LANE,
  };
}

test("shared path: success confirm composes after execute (no extension language)", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  let decideCalls = 0;
  let composeCalls = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Yes book kr dain",
    messageId: "dec-success-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => {
      decideCalls += 1;
      return confirmDecision();
    },
    __composeWaitingConfirmExecutionReplyForTests: async (args) => {
      composeCalls += 1;
      assert.equal(args.frozenDecision?.action, "confirm_booking");
      assert.equal(args.executionResult?.succeeded, true);
      assert.ok(args.executionResult?.bookingId);
      return composeWaitingConfirmExecutionReplyForTests(args);
    },
  });
  assert.equal(decideCalls, 1);
  assert.equal(composeCalls, 1);
  assert.equal(result.action, "confirmed_booking");
  assert.equal(result.composedAfterExecution, true);
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
  assert.equal(String(sendCalls[0][1]), "Booking confirm ho gayi.");
  assert.doesNotMatch(String(sendCalls[0][1]), /aage\s+barhati|extend|process\s+karti/i);
});

test("shared path: execute disabled → compose failure wording, no booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan",
    messageId: "dec-fail-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: false,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => confirmDecision(),
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.action, "confirm_failed");
  assert.equal(result.composedAfterExecution, true);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.match(String(sendCalls[0][1]), /confirm nahi ho saki/i);
  assert.doesNotMatch(String(sendCalls[0][1]), /Booking confirm ho gayi/i);
});

test("verified booking success compose failure returns empty instead of failure fallback", async () => {
  const composed = await composeWaitingConfirmExecutionReply({
    facts: {
      itemId: ITEM_ID,
      itemLabel: "Honda Civic 2026",
      durationDays: 2,
    },
    userMessage: "haan book kar dein",
    frozenDecision: confirmDecision().decision,
    executionResult: {
      attempted: true,
      succeeded: true,
      bookingId: "booking-compose-failure-1",
      requestId: REQUEST_ID,
      itemId: ITEM_ID,
      itemLabel: "Honda Civic 2026",
      durationDays: 2,
      totalAmount: 16000,
      currency: "PKR",
    },
    __chatCompletionsCreateForTests: async () => {
      throw new Error("forced compose failure");
    },
  });

  assert.equal(composed.ok, false);
  assert.equal(composed.reply, "");
  assert.notEqual(composed.reply, WAITING_CONFIRM_DM_TECHNICAL_FALLBACK);
});

test("verified booking success with empty compose result is recoverable and sends nothing", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  let sends = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan book kar dein",
    messageId: "dec-success-compose-failed-1",
    sendWhatsAppMessageFn: async () => {
      sends += 1;
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => confirmDecision(),
    __composeWaitingConfirmExecutionReplyForTests: async () => ({
      ok: false,
      reply: "",
      reason: "COMPOSE_FAILED",
    }),
  });

  assert.equal(result.handled, false);
  assert.equal(result.retryable, true);
  assert.equal(result.action, "confirm_reply_compose_failed");
  assert.equal(result.reply, "");
  assert.equal(sends, 0);
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("shared path: duplicate inbound — no second decide/compose/outbound", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  let decideCalls = 0;
  const decide = async () => {
    decideCalls += 1;
    return confirmDecision();
  };
  const first = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan book",
    messageId: "dec-dup-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: decide,
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(first.action, "confirmed_booking");
  assert.equal(decideCalls, 1);
  assert.equal(sendCalls.length, 1);
  const bookingId = fake.getRequestDoc(REQUEST_ID).linkedBookingId;

  const second = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan book",
    messageId: "dec-dup-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: decide,
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(second.duplicate, true);
  assert.equal(decideCalls, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, bookingId);
});

test("Playwright + Cloud both use composeWaitingConfirmExecutionReply", () => {
  const src = readFileSync(
    join(ROOT, "src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.match(src, /composeWaitingConfirmExecutionReply/);
  assert.match(src, /runWaitingConfirmDmBrainTurn/);
  const cloudStart = src.indexOf(
    "export async function handleAvailabilityCustomerCloudInbound"
  );
  const pwStart = src.indexOf(
    "export async function handleAvailabilityCustomerPlaywrightInbound"
  );
  assert.ok(cloudStart >= 0);
  assert.ok(pwStart >= 0);
  assert.match(
    src.slice(Math.min(cloudStart, pwStart)),
    /composeWaitingConfirmExecutionReplyFn/
  );
});

test("Playwright confirm: compose after execute (disabled = failure wording)", async () => {
  const fake = createFakeDb();
  const req = baseWaitingRequest({
    customerConfirmationChannel: "waiting_confirm_playwright",
    customerDmChatTitle: "Customer",
    customerDmPlaywrightChatKey: "cust-key",
  });
  fake.seedAvailabilityRequest(REQUEST_ID, req);
  const replies = [];
  const result = await handleAvailabilityCustomerPlaywrightInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: { requestId: REQUEST_ID, ...req },
    messageText: "Yes book kr dain",
    messageId: "pw-dec-1",
    sendReplyFn: async (text) => {
      replies.push(text);
      return true;
    },
    availabilityConfirmExecute: false,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => confirmDecision(),
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.equal(result.composedAfterExecution, true);
  assert.equal(result.action, "confirm_failed");
  assert.match(String(replies[0]), /confirm nahi ho saki/i);
});

test("decline: execute then compose; no booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "nahi chahiye",
    messageId: "dec-decline-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => ({
      ok: true,
      decision: {
        action: "decline_request",
        customerReply: "",
        shouldReply: true,
        customerIsConfirmingBooking: false,
        customerIsAskingQuestion: false,
        customerIsDeclining: true,
        customerWantsChange: false,
        confidence: 0.9,
        requiredExecutor: "decline_request_executor",
        situation: "awaiting_confirm",
        customerIntent: "decline",
      },
      source: "test",
      lane: WAITING_CONFIRM_DM_LANE,
    }),
    __composeWaitingConfirmExecutionReplyForTests:
      composeWaitingConfirmExecutionReplyForTests,
  });
  assert.equal(result.action, "declined");
  assert.equal(result.composedAfterExecution, true);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "declined"
  );
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(String(sendCalls[0][1]), "Theek hai, booking proceed nahi kar raha.");
});

test("factual Q: reply path, no execute, no composeAfterExecution", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  let composeCalls = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "rent kitna?",
    messageId: "dec-price-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => ({
      ok: true,
      decision: {
        action: "reply",
        customerReply: "2 din ka rent 16,000 PKR hoga.",
        shouldReply: true,
        customerIsConfirmingBooking: false,
        customerIsAskingQuestion: true,
        customerIsDeclining: false,
        customerWantsChange: false,
        confidence: 0.9,
        requiredExecutor: "whatsapp_cloud_dm",
        situation: "awaiting_confirm",
        customerIntent: "ask_price",
        replySemantics: {
          claims: ["quotation_verified"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      },
      source: "test",
      lane: WAITING_CONFIRM_DM_LANE,
    }),
    __composeWaitingConfirmExecutionReplyForTests: async (args) => {
      composeCalls += 1;
      return composeWaitingConfirmExecutionReplyForTests(args);
    },
  });
  assert.equal(result.action, "reply");
  assert.notEqual(result.composedAfterExecution, true);
  assert.equal(composeCalls, 0);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.match(String(sendCalls[0][1]), /16,000 PKR/);
});

test("guard: extension language rejected on post-exec success contract", () => {
  const contract = buildPostExecutionBookingSuccessContract({
    itemId: ITEM_ID,
    itemLabel: "Honda Civic 2026",
    durationDays: 2,
    totalAmount: 16000,
    bookingExecutionVerified: true,
    styleKey: "casual_local",
  });
  const bad = validateCustomerReplyAgainstContract(
    "Confirm mil gaya, request aage barhati hun.",
    contract,
    {
      claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    }
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "new_booking_confirmation_extension_language");

  const good = validateCustomerReplyAgainstContract(
    "Booking confirm ho gayi.",
    contract,
    {
      claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    }
  );
  assert.equal(good.ok, true);
});

test("compose injector missing → technical fallback still after execute attempt", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan",
    messageId: "dec-fallback-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: false,
    __catalogRowForTests: CATALOG_ROW,
    __decideCustomerTurnForTests: async () => confirmDecision(),
    __composeWaitingConfirmExecutionReplyForTests: async () => ({
      ok: false,
      reply: "",
      source: "technical_fallback",
    }),
  });
  assert.equal(result.composedAfterExecution, true);
  assert.equal(String(sendCalls[0][1]), WAITING_CONFIRM_DM_TECHNICAL_FALLBACK);
});
