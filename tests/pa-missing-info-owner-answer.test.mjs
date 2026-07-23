import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} = await import("../src/brain/config/liveFeatureFlags.js");
const {
  handlePaMissingInfoOwnerAnswerInbound,
  tryHandlePaMissingInfoOwnerAnswer,
  parsePaMissingInfoOwnerAnswerMessage,
} = await import("../src/services/paMissingInfoOwnerAnswerService.js");
const { getPaMissingInfoRequest } = await import(
  "../src/services/paMissingInfoRequestService.js"
);

const BUSINESS_ID = "owner-pa-ans-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const OTHER_PHONE = "923007776655";
const BOOKING_ID = "bk_pa_ans_001";
const AVR_ID = "avr_pa_ans_001";
const REQUEST_ID = "pamiss_abcdef0123456789ab";

function withFlags({ missingInfo = false, ownerAnswer = false }, fn) {
  const prevMiss = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevAns = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  if (missingInfo) process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  if (ownerAnswer)
    process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevMiss === undefined)
        delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
      else process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = prevMiss;
      if (prevAns === undefined)
        delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
      else process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = prevAns;
    });
}

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
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
        ? {
            ...business[subCollection][docId].data,
            ...structuredClone(data),
          }
        : structuredClone(data);
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

  return {
    db: {
      collection(name) {
        return new CollectionRef([name]);
      },
    },
    store,
    ensureBusiness,
    setOwnerPhone(businessId, phone) {
      const b = ensureBusiness(businessId);
      b.data = { ...b.data, ownerNotificationPhone: phone };
    },
    seedBooking(businessId, bookingId, data) {
      ensureBusiness(businessId).bookings[bookingId] = { data: { ...data } };
    },
    seedAvailabilityRequest(businessId, requestId, data) {
      ensureBusiness(businessId).availabilityRequests[requestId] = {
        data: { ...data },
      };
    },
    seedMissingInfo(businessId, requestId, data) {
      ensureBusiness(businessId).paMissingInfoRequests[requestId] = {
        data: { ...data },
      };
    },
    getMissingInfo(businessId, requestId) {
      return (
        store.businesses[businessId]?.paMissingInfoRequests?.[requestId]
          ?.data ?? null
      );
    },
    getBooking(businessId, bookingId) {
      return store.businesses[businessId]?.bookings?.[bookingId]?.data ?? null;
    },
    getAvr(businessId, requestId) {
      return (
        store.businesses[businessId]?.availabilityRequests?.[requestId]?.data ??
        null
      );
    },
  };
}

function baseBooking(overrides = {}) {
  return {
    id: BOOKING_ID,
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "civic-1",
    itemLabel: "Honda Civic 2026",
    durationDays: 2,
    totalAmount: 16000,
    availabilityRequestId: AVR_ID,
    dmTargetPhone: CUSTOMER_PHONE,
    customerPhone: `+${CUSTOMER_PHONE}`,
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  const now = new Date();
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    bookingId: BOOKING_ID,
    availabilityRequestId: AVR_ID,
    missingInfoType: "advance",
    customerQuestion: "Advance kitna dena hoga?",
    customerMessageId: "wamid.cust-1",
    status: "owner_notified",
    ownerNotifyStatus: "sent",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    ...overrides,
  };
}

function seedContext(fake, { requestOverrides = {}, secondRequest = null } = {}) {
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseBooking());
  fake.seedAvailabilityRequest(BUSINESS_ID, AVR_ID, {
    requestId: AVR_ID,
    itemLabel: "Honda Civic 2026",
    status: "approved",
    customerConfirmationStatus: "confirmed",
    linkedBookingId: BOOKING_ID,
  });
  fake.seedMissingInfo(BUSINESS_ID, REQUEST_ID, baseRequest(requestOverrides));
  if (secondRequest) {
    fake.seedMissingInfo(BUSINESS_ID, secondRequest.requestId, secondRequest);
  }
}

test("owner-answer flags default off", () => {
  const prevM = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevA = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  try {
    assert.equal(isEmilyBusinessPaMissingInfoEnabled(), false);
    assert.equal(isEmilyBusinessPaMissingInfoOwnerAnswerEnabled(), false);
  } finally {
    if (prevM === undefined) delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
    else process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = prevM;
    if (prevA === undefined)
      delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
    else process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = prevA;
  }
});

test("parse pamiss token and answer", () => {
  const a = parsePaMissingInfoOwnerAnswerMessage(
    `${REQUEST_ID} advance 5000`
  );
  assert.equal(a.requestId, REQUEST_ID);
  assert.equal(a.ownerAnswer, "5000");

  const b = parsePaMissingInfoOwnerAnswerMessage(`${REQUEST_ID}: 5000 PKR`);
  assert.equal(b.requestId, REQUEST_ID);
  assert.equal(b.ownerAnswer, "5000 PKR");
});

test("owner reply with valid pamiss_* token stores answer and sends customer follow-up", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const customerSends = [];
  let openaiCalls = 0;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: `${REQUEST_ID} advance 5000`,
      messageId: "wamid.owner-1",
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, messages: [{ id: "wamid.cust-out-1" }] };
      },
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  customerReply: "Advance 5000 PKR dena hoga.",
                  needsFollowup: false,
                  missingInfoType: null,
                }),
              },
            },
          ],
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.customerFollowupSent, true);
    assert.equal(result.requestId, REQUEST_ID);
    assert.equal(openaiCalls, 1);
    assert.equal(customerSends.length, 1);
    assert.equal(phoneDigits(customerSends[0].to), CUSTOMER_PHONE);
    assert.equal(customerSends[0].text, "Advance 5000 PKR dena hoga.");

    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "closed");
    assert.equal(row.ownerAnswer, "5000");
    assert.equal(row.ownerAnswerMessageId, "wamid.owner-1");
    assert.equal(row.customerFollowupText, "Advance 5000 PKR dena hoga.");
    assert.equal(row.customerFollowupStatus, "sent");

    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
    assert.equal(
      fake.getBooking(BUSINESS_ID, BOOKING_ID).approvalStage,
      "owner_approved_waiting_customer_details"
    );
    assert.equal(
      fake.getAvr(BUSINESS_ID, AVR_ID).customerConfirmationStatus,
      "confirmed"
    );
  });
});

function phoneDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}

test("duplicate same owner message does not send twice", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  let sendCount = 0;
  const common = {
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: `${REQUEST_ID} 5000`,
    messageId: "wamid.owner-dup",
    sendWhatsAppMessageFn: async () => {
      sendCount += 1;
      return { ok: true, messages: [{ id: "wamid.x" }] };
    },
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Advance 5000 PKR.",
              needsFollowup: false,
              missingInfoType: null,
            }),
          },
        },
      ],
    }),
  };

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const first = await handlePaMissingInfoOwnerAnswerInbound(common);
    const second = await handlePaMissingInfoOwnerAnswerInbound(common);
    assert.equal(first.customerFollowupSent, true);
    assert.equal(second.customerFollowupSent, false);
    assert.ok(
      second.reason === "IDEMPOTENT_SAME_MESSAGE" ||
        second.reason === "ALREADY_ANSWERED"
    );
    assert.equal(sendCount, 1);
  });
});

test("duplicate reply after closed does not send twice", async () => {
  const fake = createFakeDb();
  seedContext(fake, {
    requestOverrides: {
      status: "closed",
      ownerAnswer: "5000",
      ownerAnswerMessageId: "wamid.old",
      customerFollowupStatus: "sent",
      closedAt: new Date(),
    },
  });
  let sendCount = 0;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: `${REQUEST_ID} 7000`,
      messageId: "wamid.owner-after-close",
      sendWhatsAppMessageFn: async () => {
        sendCount += 1;
        return { ok: true };
      },
      __chatCompletionsCreateForTests: async () => {
        throw new Error("should not call openai");
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.customerFollowupSent, false);
    assert.equal(result.reason, "ALREADY_ANSWERED");
    assert.equal(sendCount, 0);
    assert.equal(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer, "5000");
  });
});

test("owner reply without token + exactly one open request matches", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const sends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance 50 percent hai",
      messageId: "wamid.owner-no-token",
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, messages: [{ id: "wamid.y" }] };
      },
      __chatCompletionsCreateForTests: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Advance 50 percent hai.",
                needsFollowup: false,
                missingInfoType: null,
              }),
            },
          },
        ],
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.matchReason, "SINGLE_OPEN");
    assert.equal(result.customerFollowupSent, true);
    assert.equal(sends.length, 1);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer,
      "Advance 50 percent hai"
    );
  });
});

test("owner reply without token + multiple open requests does not match", async () => {
  const fake = createFakeDb();
  const now = new Date();
  seedContext(fake, {
    secondRequest: {
      requestId: "pamiss_bbbbbbbbbbbbbbbbbb",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "driver",
      customerQuestion: "Driver hai?",
      status: "open",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  let sendCount = 0;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Driver available hai",
      messageId: "wamid.owner-multi",
      sendWhatsAppMessageFn: async () => {
        sendCount += 1;
        return { ok: true };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "AMBIGUOUS_OPEN_REQUESTS");
    assert.equal(result.customerFollowupSent, false);
    assert.equal(sendCount, 0);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
  });
});

test("non-owner customer DM does not trigger owner-answer handler", async () => {
  const fake = createFakeDb();
  seedContext(fake);

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OTHER_PHONE,
      messageText: `${REQUEST_ID} 5000`,
      messageId: "wamid.cust",
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "NOT_OWNER");

    const tryResult = await tryHandlePaMissingInfoOwnerAnswer({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OTHER_PHONE,
      messageText: `${REQUEST_ID} 5000`,
    });
    assert.equal(tryResult, null);
  });
});

test("flag OFF means no owner-answer handling", async () => {
  const fake = createFakeDb();
  seedContext(fake);

  await withFlags({ missingInfo: true, ownerAnswer: false }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: `${REQUEST_ID} 5000`,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "FLAG_OFF");
  });

  await withFlags({ missingInfo: false, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: `${REQUEST_ID} 5000`,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "FLAG_OFF");
  });
});

test("customer follow-up uses OpenAI helper, not canned reply map", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  let sawOwnerAnswerInPrompt = false;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const mod = await import("../src/services/paMissingInfoOwnerAnswerService.js");
    assert.equal("HOLD_REPLIES" in mod, false);
    assert.equal(typeof mod.PA_TOPIC_REPLY_MAP, "undefined");

    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: `${REQUEST_ID} 5000`,
      messageId: "wamid.openai",
      sendWhatsAppMessageFn: async () => ({ ok: true, messages: [{ id: "o" }] }),
      __chatCompletionsCreateForTests: async (args) => {
        const blob = JSON.stringify(args);
        sawOwnerAnswerInPrompt = /OWNER_ANSWER_FOR_THIS_REQUEST/.test(blob);
        assert.doesNotMatch(blob, /HOLD_REPLIES/);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  customerReply: "Advance 5000 PKR confirm hai.",
                  needsFollowup: false,
                  missingInfoType: null,
                }),
              },
            },
          ],
        };
      },
    });
    assert.equal(result.openaiUsed, true);
    assert.equal(sawOwnerAnswerInPrompt, true);
    assert.equal(result.customerFollowupText, "Advance 5000 PKR confirm hai.");
  });
});

test("getPaMissingInfoRequest loads by id", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const row = await getPaMissingInfoRequest({
    db: fake.db,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
  });
  assert.equal(row.requestId, REQUEST_ID);
  assert.equal(row.status, "owner_notified");
});
