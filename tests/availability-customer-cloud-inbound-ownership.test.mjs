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
  findFreshTrustedWaitingConfirmCloudOwnershipCandidate,
  isFreshTrustedWaitingConfirmCloudOwnershipCandidate,
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
    ensureBusiness(BUSINESS_ID).inventory["corolla-1"] = {
      data: {
        id: "corolla-1",
        name: "Toyota Corolla",
        label: "Toyota Corolla",
        dailyRate: 5000,
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

  function getBookings() {
    return Object.entries(store.businesses[BUSINESS_ID]?.bookings ?? {}).map(
      ([id, row]) => ({ id, ...(row?.data ?? {}) })
    );
  }

  return {
    db,
    seedAvailabilityRequest,
    seedInventoryItem,
    getRequestDoc,
    getBookingCount,
    getBookings,
    store,
  };
}

function baseCloudWaitingRequest(overrides = {}) {
  const sentAt = new Date(Date.now() - 5_000);
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
    customerDeliveryStatus: "delivered",
    customerDeliveryTimestamp: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerDmPromptAt: sentAt,
    lastCustomerDmOutboundAt: sentAt,
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

test("fresh waiting-confirm ownership requires delivered prompt before inbound", async () => {
  const promptAt = Date.now() - 5_000;
  const eligible = baseCloudWaitingRequest({
    approvalCustomerNotificationAt: new Date(promptAt),
    customerDeliveryStatus: "delivered",
    customerDeliveryTimestamp: new Date(promptAt + 500),
    lastCustomerDmPromptAt: new Date(promptAt),
  });
  assert.equal(
    isFreshTrustedWaitingConfirmCloudOwnershipCandidate(eligible, {
      inboundReceivedAtMs: promptAt + 1_000,
    }),
    true
  );
  assert.equal(
    isFreshTrustedWaitingConfirmCloudOwnershipCandidate(eligible, {
      inboundReceivedAtMs: promptAt,
    }),
    false
  );
  assert.equal(
    isFreshTrustedWaitingConfirmCloudOwnershipCandidate(
      { ...eligible, customerDeliveryStatus: "failed" },
      { inboundReceivedAtMs: promptAt + 1_000 }
    ),
    false
  );

  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, eligible);
  const selected =
    await findFreshTrustedWaitingConfirmCloudOwnershipCandidate({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      inboundReceivedAtMs: promptAt + 1_000,
    });
  assert.equal(selected?.requestId, REQUEST_ID);
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
  waitingConfirmDecision = null,
  waitingConfirmSendSpy = async () => ({ ok: true }),
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
            sendWhatsAppMessageFn: waitingConfirmSendSpy,
            __waitingConfirmDmBrainEnabled:
              waitingConfirmDecision == null ? null : true,
            __decideCustomerTurnForTests:
              waitingConfirmDecision == null
                ? null
                : async (turnContext) => ({
                    ok: true,
                    source: "test_openai",
                    lane: "waiting_confirm_dm",
                    turnContext,
                    decision: {
                      ...waitingConfirmDecision,
                    },
                  }),
            __catalogRowForTests:
              waitingConfirmDecision == null
                ? undefined
                : {
                    id:
                      params.preselectedWaitingConfirmRequest?.itemId ??
                      "civic-1",
                    name:
                      params.preselectedWaitingConfirmRequest?.itemLabel ??
                      "Honda Civic 2026",
                    displayLabel:
                      params.preselectedWaitingConfirmRequest?.itemLabel ??
                      "Honda Civic 2026",
                    dailyRate:
                      params.preselectedWaitingConfirmRequest?.priceQuote
                        ?.dailyRate ?? 8000,
                  },
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

function activeCivicPostConfirmFacts() {
  return {
    ok: true,
    reason: "MATCHED",
    facts: {
      booking: {
        id: "booking-existing-civic",
        itemId: "civic-1",
        itemLabel: "Honda Civic 2026",
        durationDays: 5,
        status: "approved",
      },
      pendingAvailabilityRequests: [],
    },
  };
}

function waitingConfirmOpenAiDecision(overrides = {}) {
  return {
    conversationStage: "booking_offer",
    customerIntent: "unclear",
    situation: "awaiting_confirm",
    customerIsConfirmingBooking: false,
    customerIsAskingQuestion: false,
    customerIsDeclining: false,
    customerWantsChange: false,
    shouldReply: true,
    customerReply: "OpenAI waiting-confirm reply",
    action: "reply",
    confidence: 0.99,
    requiredExecutor: "whatsapp_cloud_dm",
    ...overrides,
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

test("fresh Corolla waiting-confirm wins over older Civic post-confirm ownership", async () => {
  let paCalls = 0;
  let waitingConfirmSends = 0;
  const activeFacts = activeCivicPostConfirmFacts();
  const activeFactsBefore = structuredClone(activeFacts);
  const request = baseCloudWaitingRequest({
    itemId: "corolla-1",
    itemLabel: "Toyota Corolla",
    requestedDuration: 3,
    priceQuote: {
      status: "quoted",
      total: 15000,
      currency: "PKR",
      durationDays: 3,
      dailyRate: 5000,
    },
  });
  const { fake, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: request,
    inboundText: "Han kar do",
    pipelineParams: {
      messageTimestamp: Math.floor(Date.now() / 1000),
      __resolveActiveCustomerBookingFactsFn: async () => activeFacts,
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return {
          handled: true,
          reply: "Civic post-confirm should not run",
          bookingId: "booking-existing-civic",
        };
      },
    },
    waitingConfirmDecision: waitingConfirmOpenAiDecision({
      customerIntent: "confirm_booking",
      customerIsConfirmingBooking: true,
      shouldReply: true,
      customerReply: "OpenAI confirms the Corolla booking.",
      action: "confirm_booking",
      requiredExecutor: "confirm_booking_executor",
    }),
    waitingConfirmSendSpy: async () => {
      waitingConfirmSends += 1;
      return { ok: true };
    },
  });

  assert.equal(paCalls, 0);
  assert.equal(waitingConfirmSends, 1);
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
  const updatedRequest = fake.getRequestDoc(REQUEST_ID);
  assert.ok(updatedRequest.linkedBookingId);
  assert.equal(fake.getBookingCount(), 1);
  assert.equal(fake.getBookings()[0]?.itemId, "corolla-1");
  assert.deepEqual(activeFacts, activeFactsBefore);
});

test("fresh Corolla waiting-confirm Q&A stays in OpenAI lane with zero booking", async () => {
  let paCalls = 0;
  let waitingConfirmSends = 0;
  const { fake, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: baseCloudWaitingRequest({
      itemId: "corolla-1",
      itemLabel: "Toyota Corolla",
      requestedDuration: 3,
      priceQuote: {
        status: "quoted",
        total: 15000,
        currency: "PKR",
        durationDays: 3,
        dailyRate: 5000,
      },
    }),
    inboundText: "3 din ka rent kitna ho ga?",
    pipelineParams: {
      messageTimestamp: Math.floor(Date.now() / 1000),
      __resolveActiveCustomerBookingFactsFn: async () =>
        activeCivicPostConfirmFacts(),
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return { handled: true, reply: "wrong Civic lane" };
      },
    },
    waitingConfirmDecision: waitingConfirmOpenAiDecision({
      customerIntent: "price_question",
      customerIsAskingQuestion: true,
      customerReply: "Toyota Corolla ka 3 din ka verified rent 15,000 PKR hai.",
      action: "reply",
      requiredExecutor: "whatsapp_cloud_dm",
    }),
    waitingConfirmSendSpy: async (_phone, reply) => {
      waitingConfirmSends += 1;
      assert.match(reply, /Corolla/i);
      assert.match(reply, /15,000 PKR/i);
      return { ok: true };
    },
  });

  assert.equal(paCalls, 0);
  assert.equal(waitingConfirmSends, 1);
  assert.equal(fake.getBookingCount(), 0);
  assert.equal(fake.getRequestDoc(REQUEST_ID).linkedBookingId, undefined);
  assert.equal(
    fake.getRequestDoc(REQUEST_ID).customerConfirmationStatus,
    "waiting_confirm"
  );
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
});

test("fresh waiting-confirm clarification is not silently completed by post-confirm", async () => {
  let paCalls = 0;
  let waitingConfirmSends = 0;
  const { fake, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: baseCloudWaitingRequest({
      itemId: "corolla-1",
      itemLabel: "Toyota Corolla",
      requestedDuration: 3,
    }),
    inboundText: "???",
    pipelineParams: {
      messageTimestamp: Math.floor(Date.now() / 1000),
      __resolveActiveCustomerBookingFactsFn: async () =>
        activeCivicPostConfirmFacts(),
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return { handled: true, reply: "" };
      },
    },
    waitingConfirmDecision: waitingConfirmOpenAiDecision({
      customerIntent: "unclear",
      customerReply: "Toyota Corolla booking confirm karni hai?",
      action: "clarify",
      requiredExecutor: "whatsapp_cloud_dm",
    }),
    waitingConfirmSendSpy: async (_phone, reply) => {
      waitingConfirmSends += 1;
      assert.match(reply, /Corolla/i);
      return { ok: true };
    },
  });

  assert.equal(paCalls, 0);
  assert.equal(waitingConfirmSends, 1);
  assert.equal(fake.getBookingCount(), 0);
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
});

test("without eligible waiting-confirm, existing Civic post-confirm behavior is unchanged", async () => {
  let paCalls = 0;
  const { cloudConfirmCalls, outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: null,
    inboundText: "Pickup details?",
    pipelineParams: {
      __resolveActiveCustomerBookingFactsFn: async () =>
        activeCivicPostConfirmFacts(),
      __tryHandleCustomerBusinessPaInboundFn: async ({ preResolvedBookingFacts }) => {
        paCalls += 1;
        assert.equal(
          preResolvedBookingFacts?.facts?.booking?.itemId,
          "civic-1"
        );
        return {
          handled: true,
          reply: "OpenAI Civic post-confirm reply",
          bookingId: "booking-existing-civic",
          openaiUsed: true,
          openaiSource: "openai_post_confirm_pa",
        };
      },
    },
  });

  assert.equal(cloudConfirmCalls, 0);
  assert.equal(paCalls, 1);
  assert.equal(outcome?.reply, "OpenAI Civic post-confirm reply");
  assert.equal(outcome?.messageMeta?.finalReplySource, "openai_post_confirm_pa");
});

for (const [label, requestPatch] of [
  ["expired", { confirmExpiresAt: new Date(Date.now() - 60_000) }],
  ["already-linked", { linkedBookingId: "booking-corolla-existing" }],
]) {
  test(`${label} waiting-confirm does not steal Civic post-confirm ownership`, async () => {
    let paCalls = 0;
    let confirmCalls = 0;
    const { outcome } = await runCloudOwnershipPipeline({
      availabilityRequestData: baseCloudWaitingRequest(requestPatch),
      inboundText: "Pickup details?",
      pipelineParams: {
        __resolveActiveCustomerBookingFactsFn: async () =>
          activeCivicPostConfirmFacts(),
        __tryHandleCustomerBusinessPaInboundFn: async () => {
          paCalls += 1;
          return {
            handled: true,
            reply: "OpenAI Civic post-confirm reply",
            bookingId: "booking-existing-civic",
            openaiUsed: true,
            openaiSource: "openai_post_confirm_pa",
          };
        },
      },
      cloudConfirmSpy: async () => {
        confirmCalls += 1;
        return { handled: true, reply: "must not run" };
      },
    });
    assert.equal(confirmCalls, 0);
    assert.equal(paCalls, 1);
    assert.equal(outcome?.messageMeta?.finalReplySource, "openai_post_confirm_pa");
  });
}

test("genuine waiting-confirm NO_MATCH falls through once to Civic post-confirm", async () => {
  let confirmCalls = 0;
  let paCalls = 0;
  const { outcome } = await runCloudOwnershipPipeline({
    availabilityRequestData: baseCloudWaitingRequest(),
    inboundText: "Pickup details?",
    pipelineParams: {
      messageTimestamp: Math.floor(Date.now() / 1000),
      __resolveActiveCustomerBookingFactsFn: async () =>
        activeCivicPostConfirmFacts(),
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return {
          handled: true,
          reply: "OpenAI Civic fallback reply",
          bookingId: "booking-existing-civic",
          openaiUsed: true,
          openaiSource: "openai_post_confirm_pa",
        };
      },
    },
    cloudConfirmSpy: async () => {
      confirmCalls += 1;
      return { handled: false, reason: "NO_MATCH" };
    },
  });
  assert.equal(confirmCalls, 1);
  assert.equal(paCalls, 1);
  assert.equal(outcome?.reply, "OpenAI Civic fallback reply");
  assert.equal(outcome?.messageMeta?.finalReplySource, "openai_post_confirm_pa");
});

test("duplicate provider ID executes waiting-confirm OpenAI, booking and send once", async () => {
  const fake = createFakeDb();
  fake.seedInventoryItem();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseCloudWaitingRequest({
      itemId: "corolla-1",
      itemLabel: "Toyota Corolla",
      requestedDuration: 3,
    })
  );
  const providerMessageId = `wamid.waiting-dup-${randomUUID()}`;
  let openAiCalls = 0;
  let sends = 0;
  const params = {
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Han kar do",
    messageId: providerMessageId,
    availabilityConfirmExecute: true,
    __waitingConfirmDmBrainEnabled: true,
    __catalogRowForTests: {
      id: "corolla-1",
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla",
      dailyRate: 5000,
    },
    __decideCustomerTurnForTests: async (turnContext) => {
      openAiCalls += 1;
      return {
        ok: true,
        source: "test_openai",
        lane: "waiting_confirm_dm",
        turnContext,
        decision: waitingConfirmOpenAiDecision({
          customerIntent: "confirm_booking",
          customerIsConfirmingBooking: true,
          action: "confirm_booking",
          customerReply: "OpenAI confirms the Corolla booking.",
          requiredExecutor: "confirm_booking_executor",
        }),
      };
    },
    sendWhatsAppMessageFn: async () => {
      sends += 1;
      return { ok: true };
    },
  };
  const first = await handleAvailabilityCustomerCloudInbound(params);
  const second = await handleAvailabilityCustomerCloudInbound(params);

  assert.equal(first.action, "confirmed_booking");
  assert.equal(second.action, "duplicate_inbound");
  assert.equal(openAiCalls, 1);
  assert.equal(fake.getBookingCount(), 1);
  assert.equal(sends, 1);
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
