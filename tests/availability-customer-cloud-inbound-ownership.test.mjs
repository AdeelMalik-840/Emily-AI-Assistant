import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { AVAILABILITY_DM_PROMPT_TYPES } = await import(
  "../src/brain/availabilityConfirmation/index.js"
);
const {
  handleAvailabilityCustomerCloudInbound,
  tryHandleAvailabilityCustomerCloudInbound,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const {
  availabilityRequestMatchesCloudCustomerPhone,
  buildConfirmExpiresAt,
  isCloudWaitingConfirmAvailabilityRequestEligible,
} = await import("../src/services/availabilityRequestService.js");
const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
  isIntentionalSilentInboundResult,
} = await import("../src/services/whatsappInboundBuffer.js");

const BUSINESS_ID = "owner-cloud-confirm-1";
const REQUEST_ID = "avr_cloud_own_001";
const CUSTOMER_PHONE = "+923001111111";
const CUSTOMER_WA = "923001111111";

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
      inventory: {},
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
    async set(data, opts = {}) {
      const [rootCollection, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (rootCollection === "businesses" && !subCollection) {
        business.data = opts.merge
          ? { ...business.data, ...structuredClone(data) }
          : structuredClone(data);
        return;
      }
      business[subCollection] ||= {};
      business[subCollection][docId] ||= { data: {} };
      business[subCollection][docId].data = opts.merge
        ? { ...business[subCollection][docId].data, ...structuredClone(data) }
        : structuredClone(data);
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
        if (collection === "businesses" && i === 0) {
          node = ensureBusiness(id);
          continue;
        }
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
      const nextId = id == null ? `auto-${++autoId}` : String(id);
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
    return ref.set(data, { merge: true });
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
    ensureBusiness(BUSINESS_ID).availabilityRequests[requestId] = {
      data: { ...data },
    };
  }

  function seedInventoryItem() {
    ensureBusiness(BUSINESS_ID).inventory["civic-1"] = {
      data: {
        id: "civic-1",
        name: "Honda Civic 2026",
        label: "Honda Civic 2026",
        dailyRate: 8000,
        available: true,
      },
    };
  }

  function getRequestDoc(requestId) {
    return store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]?.data ?? null;
  }

  function getBookingCount() {
    return Object.keys(store.businesses[BUSINESS_ID]?.bookings ?? {}).length;
  }

  return { db, seedAvailabilityRequest, seedInventoryItem, getRequestDoc, getBookingCount, store };
}

function baseCloudWaitingRequest(overrides = {}) {
  const sentAt = new Date();
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "civic-1",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 2,
    customerDmTarget: CUSTOMER_PHONE,
    customerPhone: CUSTOMER_PHONE,
    customerPhoneNormalized: CUSTOMER_WA,
    customerWaId: CUSTOMER_WA,
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

test("cloud phone matching covers wa_id and normalized phone", () => {
  const request = baseCloudWaitingRequest({
    customerPhone: null,
    customerDmTarget: null,
    customerWaId: "923001111111",
    customerPhoneNormalized: null,
  });
  assert.equal(availabilityRequestMatchesCloudCustomerPhone(request, "+923001111111"), true);
  assert.equal(availabilityRequestMatchesCloudCustomerPhone(request, "923009999999"), false);
});

test("cloud eligibility requires waiting_confirm_cloud and rejects playwright channel", () => {
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(baseCloudWaitingRequest()),
    true
  );
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      baseCloudWaitingRequest({
        customerConfirmationChannel: "reply_private_then_cloud_handoff",
        customerDmChatTitle: "Adeel",
        customerDmPlaywrightChatKey: "adeel",
      })
    ),
    false
  );
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      baseCloudWaitingRequest({ confirmExpiresAt: new Date(Date.now() - 1000) })
    ),
    false
  );
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      baseCloudWaitingRequest({ linkedBookingId: "book-1" })
    ),
    false
  );
});

test("Kar do on waiting_confirm_cloud confirms via cloud inbound handler", async () => {
  const fake = createFakeDb();
  fake.seedInventoryItem();
  fake.seedAvailabilityRequest(REQUEST_ID, baseCloudWaitingRequest());
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_WA,
    messageText: "Kar do",
    messageId: "wamid.kar-do-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
  });
  assert.equal(result.handled, true);
  assert.equal(result.action, "confirmed_booking");
  assert.equal(sendCalls.length, 1);
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("duplicate same Cloud messageId does not double-book or double-send", async () => {
  const fake = createFakeDb();
  fake.seedInventoryItem();
  fake.seedAvailabilityRequest(REQUEST_ID, baseCloudWaitingRequest());
  const sendCalls = [];
  const messageId = "wamid.dup-1";
  const first = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Kar do",
    messageId,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
  });
  assert.equal(first.action, "confirmed_booking");
  const bookingsAfterFirst = fake.getBookingCount();
  const second = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Kar do",
    messageId,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
  });
  assert.equal(second.handled, true);
  assert.equal(second.action, "duplicate_inbound");
  assert.equal(second.duplicate, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(fake.getBookingCount(), bookingsAfterFirst);
});

test("channel not waiting_confirm_cloud is not hijacked", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseCloudWaitingRequest({
      customerConfirmationChannel: "reply_private_then_cloud_handoff",
      customerDmChatTitle: "Adeel",
      customerDmPlaywrightChatKey: "adeel",
    })
  );
  const result = await tryHandleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Kar do",
    messageId: "wamid.pw-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    availabilityConfirmExecute: true,
  });
  assert.equal(result, null);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
});

test("linked booking does not create a second booking", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseCloudWaitingRequest({ linkedBookingId: "book-already" })
  );
  const sendCalls = [];
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Kar do",
    messageId: "wamid.linked-1",
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    availabilityConfirmExecute: true,
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "NO_WAITING_REQUEST");
  assert.equal(sendCalls.length, 0);
  assert.equal(fake.getBookingCount(), 0);
});

function resetPipelineTestIsolation() {
  __clearWhatsAppInboundBufferForTests();
  delete globalThis.__activeJob;
  delete globalThis.__activeJobStart;
  globalThis.__forceProcessing = false;
  if (Array.isArray(globalThis.__messageQueue)) globalThis.__messageQueue.length = 0;
}

function dedupeSafePipelineMessage(text) {
  const base = String(text ?? "").trim();
  return `${base} [test:${randomUUID()}]`;
}

async function runCloudOwnershipPipeline({
  availabilityRequestData = baseCloudWaitingRequest(),
  pipelineParams = {},
  cloudConfirmSpy = null,
  brainV2Spy = async () => ({
    handled: true,
    legacyBypassed: true,
    workflowType: "ClarificationWorkflow",
    reply: "Main samajh nahi paaya.",
    sendVia: "CLOUD_API",
    messageMeta: {},
  }),
  processSpy = async () => ({
    reply: "legacy-reply",
    sendVia: "CLOUD_API",
    messageMeta: {},
  }),
  inboundText = "Kar do",
} = {}) {
  resetPipelineTestIsolation();
  const fake = createFakeDb();
  fake.seedInventoryItem();
  if (availabilityRequestData) {
    fake.seedAvailabilityRequest(REQUEST_ID, availabilityRequestData);
  }

  let brainV2Calls = 0;
  let processCalls = 0;
  let cloudConfirmCalls = 0;
  let outcome = null;
  const pipelineMessage = dedupeSafePipelineMessage(
    pipelineParams.combinedMessage ?? pipelineParams.latestMessage ?? inboundText
  );

  const prevLive = process.env.EMILY_BRAIN_V2_LIVE;
  const prevBiz = process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES;
  const prevAllow = process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";

  try {
    await executeWhatsAppAiPipeline({
      db: fake.db,
      ownerUserId: BUSINESS_ID,
      userPhone: CUSTOMER_WA,
      conversationCustomerNumber: CUSTOMER_WA,
      participantPhoneForDm: CUSTOMER_WA,
      sessionKey: `${BUSINESS_ID}::${CUSTOMER_WA}::${randomUUID()}`,
      sendCredentials: { accessToken: "t", phoneNumberId: "1" },
      isGroupMessage: false,
      playwrightWebInbound: false,
      ...pipelineParams,
      combinedMessage: pipelineMessage,
      latestMessage: pipelineMessage,
      messageId: `wamid.pipeline-${randomUUID()}`,
      __tryHandleAvailabilityCustomerCloudInboundFn:
        cloudConfirmSpy ||
        (async (params) => {
          cloudConfirmCalls += 1;
          return tryHandleAvailabilityCustomerCloudInbound({
            ...params,
            db: fake.db,
            // Strip UUID suffix used only for buffer dedupe isolation.
            messageText: String(params.messageText ?? "")
              .replace(/\s*\[test:[^\]]+\]\s*$/, "")
              .trim(),
            availabilityConfirmExecute: true,
            sendWhatsAppMessageFn: async () => ({ ok: true }),
          });
        }),
      __tryBrainV2LiveBeforeLegacyFn: async (...args) => {
        brainV2Calls += 1;
        return brainV2Spy(...args);
      },
      __processMessageFn: async (...args) => {
        processCalls += 1;
        return processSpy(...args);
      },
      __capturePipelineOutcomeForTests: (result) => {
        outcome = result;
      },
    });
  } finally {
    if (prevLive === undefined) delete process.env.EMILY_BRAIN_V2_LIVE;
    else process.env.EMILY_BRAIN_V2_LIVE = prevLive;
    if (prevBiz === undefined) delete process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES;
    else process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = prevBiz;
    if (prevAllow === undefined) delete process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
    else process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = prevAllow;
  }

  return {
    fake,
    brainV2Calls,
    processCalls,
    cloudConfirmCalls,
    outcome,
  };
}

test("buffer Cloud DM Kar do routes to confirm service and skips Brain", async () => {
  const { brainV2Calls, processCalls, cloudConfirmCalls, outcome, fake } =
    await runCloudOwnershipPipeline();
  assert.equal(cloudConfirmCalls, 1);
  assert.equal(brainV2Calls, 0);
  assert.equal(processCalls, 0);
  assert.equal(outcome?.sendVia, "NONE");
  assert.equal(outcome?.reply, "");
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
  assert.equal(
    outcome?.messageMeta?.outboundTrace?.finalReplySource,
    "AVAILABILITY_CUSTOMER_CLOUD_CONFIRM"
  );
  assert.notEqual(
    outcome?.messageMeta?.outboundTrace?.kind,
    "silent_noop"
  );
  assert.equal(isIntentionalSilentInboundResult(outcome), true);
  assert.ok(fake.getRequestDoc(REQUEST_ID).linkedBookingId);
});

test("buffer does not send a second reply when confirm service handled", async () => {
  let confirmSends = 0;
  const { brainV2Calls, processCalls, outcome } = await runCloudOwnershipPipeline({
    cloudConfirmSpy: async () => {
      confirmSends += 1;
      return {
        handled: true,
        action: "confirmed_booking",
        reply: "Booking confirm ho gayi.",
        requestId: REQUEST_ID,
      };
    },
  });
  assert.equal(confirmSends, 1);
  assert.equal(brainV2Calls, 0);
  assert.equal(processCalls, 0);
  assert.equal(outcome?.sendVia, "NONE");
  assert.equal(outcome?.reply, "");
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
});

test("no active AVR falls back to Brain unchanged", async () => {
  const { brainV2Calls, processCalls, cloudConfirmCalls, outcome } =
    await runCloudOwnershipPipeline({
      availabilityRequestData: null,
    });
  assert.equal(cloudConfirmCalls, 1);
  assert.equal(brainV2Calls, 1);
  assert.equal(processCalls, 0);
  assert.equal(outcome?.reply, "Main samajh nahi paaya.");
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, undefined);
});

test("wrong phone falls back to Brain unchanged", async () => {
  const { brainV2Calls, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: baseCloudWaitingRequest({
      customerPhone: "+923009999999",
      customerDmTarget: "+923009999999",
      customerWaId: "923009999999",
      customerPhoneNormalized: "923009999999",
    }),
  });
  assert.equal(brainV2Calls, 1);
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, undefined);
});

test("expired AVR falls back to Brain unchanged", async () => {
  const { brainV2Calls, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: baseCloudWaitingRequest({
      confirmExpiresAt: new Date(Date.now() - 60_000),
    }),
  });
  assert.equal(brainV2Calls, 1);
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, undefined);
});

test("group inbound does not run Cloud confirm ownership gate", async () => {
  let cloudConfirmCalls = 0;
  const { brainV2Calls, outcome } = await runCloudOwnershipPipeline({
    pipelineParams: {
      isGroupMessage: true,
      userPhone: "unknown",
      conversationCustomerNumber: "grpabc",
      groupName: "Rental Leads",
      playwrightChatKey: "rental-leads",
      playwrightWebTitleIdentity: true,
      playwrightWebInbound: false,
      participantPhoneForDm: "+923009999999",
      dmPlaywrightChatKey: "",
      dmChatTitle: "",
      combinedMessage: "Civic available?",
      latestMessage: "Civic available?",
    },
    cloudConfirmSpy: async () => {
      cloudConfirmCalls += 1;
      return { handled: true, action: "confirmed_booking", requestId: REQUEST_ID };
    },
    brainV2Spy: async () => ({
      handled: true,
      legacyBypassed: true,
      workflowType: "AvailabilityInquiryWorkflow",
      reply: "group-ok",
      sendVia: "GROUP",
      messageMeta: {},
    }),
  });
  assert.equal(cloudConfirmCalls, 0);
  assert.equal(brainV2Calls, 1);
  assert.equal(outcome?.reply, "group-ok");
});

test("Playwright web inbound does not run Cloud confirm ownership gate", async () => {
  let cloudConfirmCalls = 0;
  const { outcome } = await runCloudOwnershipPipeline({
    pipelineParams: {
      playwrightWebInbound: true,
      userPhone: "unknown",
      conversationCustomerNumber: "unknown",
      participantPhoneForDm: "",
      dmPlaywrightChatKey: "adeel",
      dmChatTitle: "Adeel",
      source: "PLAYWRIGHT_DM",
      combinedMessage: "hello",
      latestMessage: "hello",
    },
    cloudConfirmSpy: async () => {
      cloudConfirmCalls += 1;
      return { handled: true, action: "confirmed_booking", requestId: REQUEST_ID };
    },
    brainV2Spy: async () => ({
      handled: true,
      legacyBypassed: true,
      reply: "pw-brain",
      sendVia: "NONE",
      messageMeta: { handledWithoutOutbound: true },
    }),
  });
  assert.equal(cloudConfirmCalls, 0);
  assert.ok(outcome == null || outcome?.messageMeta?.availabilityCloudConfirmHandled !== true);
});
