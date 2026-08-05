/**
 * Owner-assist clarification loop: final_answer vs clarification_question.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  handlePaMissingInfoOwnerAnswerInbound,
  handlePaMissingInfoCustomerClarificationInbound,
  PA_MISSING_INFO_OWNER_RESPONSE_KIND_CLARIFY,
} = await import("../src/services/paMissingInfoOwnerAnswerService.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { classifyPaMissingInfoOwnerResponseKind } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);

const BUSINESS_ID = "owner-pa-clar-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const OTHER_CUSTOMER = "923004445556";
const BOOKING_ID = "bk_pa_clar_001";
const AVR_ID = "avr_pa_clar_001";
const REQUEST_ID = "pamiss_clar0123456789ab";
const REQUEST_ID_2 = "pamiss_clar9876543210zy";
const NOTIFY_WAMID = "wamid.pa-clar-notify-1";
const NOTIFY_WAMID_2 = "wamid.pa-clar-notify-2";

function withFlags(fn) {
  const prevMiss = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevAns = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";
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
      const [, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (!subCollection) {
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
      ensureBusiness(businessId).data = {
        ...ensureBusiness(businessId).data,
        ownerNotificationPhone: phone,
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
    missingInfoType: "other",
    customerQuestion: "Gari kitni chali hui hai?",
    customerMessageId: "wamid.cust-q1",
    status: "owner_notified",
    ownerNotifyStatus: "sent",
    ownerNotifyProviderMessageId: NOTIFY_WAMID,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    ...overrides,
  };
}

function seed(fake, overrides = {}, second = null) {
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedMissingInfo(BUSINESS_ID, REQUEST_ID, baseRequest(overrides));
  if (second) {
    fake.seedMissingInfo(BUSINESS_ID, second.requestId, second);
  }
}

function phoneDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}

const classifyFinal = async () => ({
  ok: true,
  kind: "final_answer",
  source: "test",
});
const classifyClarification = async () => ({
  ok: true,
  kind: "clarification_question",
  source: "test",
});

function followupOpenAiResponse(customerReply) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            needsFollowup: false,
            missingInfoType: null,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

function kindOpenAiResponse(ownerResponseKind, reason = "test") {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ ownerResponseKind, reason }),
        },
      },
    ],
  };
}

function statusOpenAiResponse(customerReply) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

const statusReplyForwarded = async () => ({
  ok: true,
  reply: "Aapka jawab owner tak forward ho gaya hai.",
  source: "test",
});
const statusReplyAmbiguous = async () => ({
  ok: true,
  reply: "Kai pending sawal hain — thoda clear bata dein kaunsa jawab hai.",
  source: "test",
});

test("owner final answer path remains unchanged (closes after send)", async () => {
  const fake = createFakeDb();
  seed(fake);
  const sends = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Around 42000 km",
      messageId: "wamid.owner-final-1",
      contextMessageId: NOTIFY_WAMID,
      __classifyOwnerResponseKindFn: classifyFinal,
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-final-out" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Civic ki mileage around 42000 km hai."),
    });
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_SENT");
    assert.equal(result.status, "closed");
    assert.equal(result.ownerResponseKind, "final_answer");
    assert.equal(sends.length, 1);
    assert.equal(phoneDigits(sends[0].to), CUSTOMER_PHONE);
    assert.equal(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status, "closed");
  });
});

test("owner clarification keeps request open and reaches correct customer", async () => {
  const fake = createFakeDb();
  seed(fake);
  const sends = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kon c gari ka poch ry ho?",
      messageId: "wamid.owner-clar-1",
      contextMessageId: NOTIFY_WAMID,
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-clar-out" };
      },
      __generateClarificationRelayFn: async () => ({
        ok: true,
        reply: "Kaunsi gari ke bare mein pooch rahe hain?",
        source: "test",
      }),
    });
    assert.equal(result.reason, "CUSTOMER_CLARIFICATION_SENT");
    assert.equal(result.status, "awaiting_customer_clarification");
    assert.equal(result.ownerResponseKind, "clarification_question");
    assert.equal(sends.length, 1);
    assert.equal(phoneDigits(sends[0].to), CUSTOMER_PHONE);
    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "awaiting_customer_clarification");
    assert.equal(row.ownerClarificationText, "Kon c gari ka poch ry ho?");
    assert.notEqual(row.status, "closed");
  });
});

test("customer answer reaches correct owner request and rotates notify wamid", async () => {
  const fake = createFakeDb();
  seed(fake, {
    status: "awaiting_customer_clarification",
    ownerClarificationText: "Kon c gari ka poch ry ho?",
    ownerClarificationMessageId: "wamid.owner-clar-1",
    customerClarificationPromptText: "Kaunsi gari?",
  });
  const ownerSends = [];
  const customerSends = [];
  const situations = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoCustomerClarificationInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "civic",
      messageId: "wamid.cust-clar-ans-1",
      sendWhatsAppMessageFn: async (to, text) => {
        const digits = String(to).replace(/\D/g, "");
        if (digits === OWNER_PHONE) {
          ownerSends.push({ to, text });
          return { ok: true, providerMessageId: "wamid.owner-relay-2" };
        }
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-ack-1" };
      },
      __generateClarificationStatusReplyFn: async (p) => {
        situations.push(p.situation);
        return statusReplyForwarded();
      },
    });
    assert.equal(result.reason, "OWNER_CLARIFICATION_RELAY_SENT");
    assert.equal(result.ownerNotifyProviderMessageId, "wamid.owner-relay-2");
    assert.equal(ownerSends.length, 1);
    assert.match(ownerSends[0].text, /civic/i);
    assert.match(ownerSends[0].text, /Gari kitni chali/i);
    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "owner_notified");
    assert.equal(row.ownerNotifyProviderMessageId, "wamid.owner-relay-2");
    assert.equal(row.customerClarificationAnswer, "civic");
    assert.equal(customerSends.length, 1);
    assert.deepEqual(situations, ["customer_answer_forwarded_to_owner"]);
    assert.match(customerSends[0].text, /forward/i);
  });
});

test("final owner reply after clarification reaches customer and closes", async () => {
  const fake = createFakeDb();
  seed(fake, {
    status: "owner_notified",
    ownerNotifyProviderMessageId: "wamid.owner-relay-2",
    ownerClarificationText: "Kon c gari?",
    customerClarificationAnswer: "civic",
    ownerClarificationRelayStatus: "sent",
  });
  const sends = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Civic ki 45000 km chali hui hai",
      messageId: "wamid.owner-final-2",
      contextMessageId: "wamid.owner-relay-2",
      __classifyOwnerResponseKindFn: classifyFinal,
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-final-2" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Civic ki mileage 45000 km hai."),
    });
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_SENT");
    assert.equal(result.status, "closed");
    assert.equal(sends.length, 1);
    assert.equal(phoneDigits(sends[0].to), CUSTOMER_PHONE);
    assert.equal(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status, "closed");
  });
});

test("failed customer clarification send remains recoverable (not closed)", async () => {
  const fake = createFakeDb();
  seed(fake);
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kaunsi gari?",
      messageId: "wamid.owner-clar-fail",
      contextMessageId: NOTIFY_WAMID,
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async () => {
        throw new Error("WHATSAPP_DOWN");
      },
      __generateClarificationRelayFn: async () => ({
        ok: true,
        reply: "Kaunsi gari?",
        source: "test",
      }),
    });
    assert.equal(result.reason, "CUSTOMER_CLARIFICATION_FAILED");
    assert.equal(result.status, "owner_notified");
    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "owner_notified");
    assert.ok(row.ownerClarificationDeliveryError);
    assert.notEqual(row.status, "closed");
  });
});

test("failed owner re-notify remains awaiting and recoverable", async () => {
  const fake = createFakeDb();
  seed(fake, {
    status: "awaiting_customer_clarification",
    ownerClarificationText: "Kaunsi gari?",
  });
  await withFlags(async () => {
    const result = await handlePaMissingInfoCustomerClarificationInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Stonic",
      messageId: "wamid.cust-ans-fail",
      sendWhatsAppMessageFn: async (to) => {
        const digits = String(to).replace(/\D/g, "");
        if (digits === OWNER_PHONE) {
          throw new Error("OWNER_SEND_FAIL");
        }
        return { ok: true, providerMessageId: "wamid.x" };
      },
      __generateClarificationStatusReplyFn: statusReplyForwarded,
    });
    assert.equal(result.reason, "OWNER_CLARIFICATION_RELAY_FAILED");
    assert.equal(result.recoverable, true);
    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "awaiting_customer_clarification");
    assert.equal(row.customerClarificationAnswer, "Stonic");
    assert.equal(row.ownerClarificationRelayStatus, "failed");
  });
});

test("duplicate owner clarification webhook does not resend", async () => {
  const fake = createFakeDb();
  seed(fake);
  let sendCount = 0;
  const common = {
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: "Kaunsi gari?",
    messageId: "wamid.owner-clar-dup",
    contextMessageId: NOTIFY_WAMID,
    __classifyOwnerResponseKindFn: classifyClarification,
    sendWhatsAppMessageFn: async () => {
      sendCount += 1;
      return { ok: true, providerMessageId: "wamid.out-dup" };
    },
    __generateClarificationRelayFn: async () => ({
      ok: true,
      reply: "Kaunsi gari?",
      source: "test",
    }),
  };
  await withFlags(async () => {
    const first = await handlePaMissingInfoOwnerAnswerInbound(common);
    const second = await handlePaMissingInfoOwnerAnswerInbound(common);
    assert.equal(first.reason, "CUSTOMER_CLARIFICATION_SENT");
    assert.equal(second.customerFollowupSent, false);
    assert.ok(
      second.reason === "IDEMPOTENT_SAME_MESSAGE" ||
        second.action === "owner_clarification_skipped"
    );
    assert.equal(sendCount, 1);
  });
});

test("duplicate customer clarification reply does not resend to owner", async () => {
  const fake = createFakeDb();
  seed(fake, {
    status: "awaiting_customer_clarification",
    ownerClarificationText: "Kaunsi gari?",
  });
  let ownerSendCount = 0;
  const common = {
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Corolla",
    messageId: "wamid.cust-dup",
    sendWhatsAppMessageFn: async (to) => {
      const digits = String(to).replace(/\D/g, "");
      if (digits === OWNER_PHONE) {
        ownerSendCount += 1;
        return { ok: true, providerMessageId: "wamid.relay-dup" };
      }
      return { ok: true, providerMessageId: "wamid.ack" };
    },
    __generateClarificationStatusReplyFn: statusReplyForwarded,
  };
  await withFlags(async () => {
    const first = await handlePaMissingInfoCustomerClarificationInbound(common);
    const second = await handlePaMissingInfoCustomerClarificationInbound(common);
    assert.equal(first.reason, "OWNER_CLARIFICATION_RELAY_SENT");
    assert.equal(second.handled, true);
    assert.equal(second.customerFollowupSent, false);
    assert.ok(
      second.reason === "IDEMPOTENT_SAME_MESSAGE" ||
        second.reason === "ALREADY_RELAYED" ||
        second.action === "customer_clarification_skipped"
    );
    assert.equal(ownerSendCount, 1);
  });
});

test("duplicate final owner answer does not resend", async () => {
  const fake = createFakeDb();
  seed(fake);
  let sendCount = 0;
  const common = {
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: "45000 km",
    messageId: "wamid.owner-final-dup",
    contextMessageId: NOTIFY_WAMID,
    __classifyOwnerResponseKindFn: classifyFinal,
    sendWhatsAppMessageFn: async () => {
      sendCount += 1;
      return { ok: true, providerMessageId: "wamid.x" };
    },
    __chatCompletionsCreateForTests: async () =>
      followupOpenAiResponse("Mileage 45000 km hai."),
  };
  await withFlags(async () => {
    const first = await handlePaMissingInfoOwnerAnswerInbound(common);
    const second = await handlePaMissingInfoOwnerAnswerInbound(common);
    assert.equal(first.customerFollowupSent, true);
    assert.equal(second.customerFollowupSent, false);
    assert.equal(sendCount, 1);
  });
});

test("two simultaneous clarification loops remain independent", async () => {
  const fake = createFakeDb();
  seed(fake, {}, null);
  fake.seedMissingInfo(
    BUSINESS_ID,
    REQUEST_ID_2,
    baseRequest({
      requestId: REQUEST_ID_2,
      customerPhone: OTHER_CUSTOMER,
      customerQuestion: "Registration kab expire?",
      ownerNotifyProviderMessageId: NOTIFY_WAMID_2,
      customerMessageId: "wamid.cust-q2",
    })
  );
  await withFlags(async () => {
    const a = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kaunsi gari mileage?",
      messageId: "wamid.o-a",
      contextMessageId: NOTIFY_WAMID,
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.out-a",
      }),
      __generateClarificationRelayFn: async () => ({
        ok: true,
        reply: "Kaunsi gari?",
        source: "test",
      }),
    });
    const b = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kaunsi gari registration?",
      messageId: "wamid.o-b",
      contextMessageId: NOTIFY_WAMID_2,
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.out-b",
      }),
      __generateClarificationRelayFn: async () => ({
        ok: true,
        reply: "Kaunsi gari?",
        source: "test",
      }),
    });
    assert.equal(a.requestId, REQUEST_ID);
    assert.equal(b.requestId, REQUEST_ID_2);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "awaiting_customer_clarification"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID_2).status,
      "awaiting_customer_clarification"
    );
  });
});

test("zero awaiting customer matches does not intercept", async () => {
  const fake = createFakeDb();
  seed(fake, { status: "owner_notified" });
  await withFlags(async () => {
    const result = await handlePaMissingInfoCustomerClarificationInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "civic",
      messageId: "wamid.none",
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "NO_AWAITING_CLARIFICATION");
  });
});

test("multiple awaiting customer matches fail safely", async () => {
  const fake = createFakeDb();
  const now = new Date();
  seed(fake, {
    status: "awaiting_customer_clarification",
    ownerClarificationText: "Q1?",
  });
  fake.seedMissingInfo(
    BUSINESS_ID,
    REQUEST_ID_2,
    baseRequest({
      requestId: REQUEST_ID_2,
      status: "awaiting_customer_clarification",
      ownerClarificationText: "Q2?",
      ownerNotifyProviderMessageId: NOTIFY_WAMID_2,
      customerQuestion: "Fuel policy?",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    })
  );
  const sends = [];
  const situations = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoCustomerClarificationInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "civic",
      messageId: "wamid.ambig",
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.ambig-out" };
      },
      __generateClarificationStatusReplyFn: async (p) => {
        situations.push(p.situation);
        return statusReplyAmbiguous();
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "AMBIGUOUS_AWAITING_CLARIFICATION");
    assert.equal(sends.length, 1);
    assert.deepEqual(situations, ["multiple_awaiting_clarification"]);
    assert.match(sends[0].text, /pending/i);
    assert.doesNotMatch(sends[0].text, /Aapka jawab owner tak bhej/i);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "awaiting_customer_clarification"
    );
  });
});

test("single eligible no-quote binds while unknown quoted context remains safe", async () => {
  const fake = createFakeDb();
  seed(fake);
  const nudges = [];
  await withFlags(async () => {
    const noQuote = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kaunsi gari?",
      messageId: "wamid.nq",
      contextMessageId: null,
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async (to, text) => {
        nudges.push(text);
        return { ok: true };
      },
    });
    assert.equal(noQuote.reason, "CUSTOMER_CLARIFICATION_SENT");
    assert.equal(noQuote.matchReason, "SINGLE_OWNER_NOTIFIED");
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "awaiting_customer_clarification"
    );
    const unknown = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Kaunsi gari?",
      messageId: "wamid.uk",
      contextMessageId: "wamid.unknown-notify",
      __classifyOwnerResponseKindFn: classifyClarification,
      sendWhatsAppMessageFn: async (to, text) => {
        nudges.push(text);
        return { ok: true };
      },
    });
    assert.equal(unknown.reason, "CONTEXT_UNKNOWN");
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "awaiting_customer_clarification"
    );
  });
});

test("agent intercepts customer clarification before normal decide", async () => {
  const fake = createFakeDb();
  seed(fake, {
    status: "awaiting_customer_clarification",
    ownerClarificationText: "Kaunsi gari?",
  });
  let decideCalled = false;
  await withFlags(async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Stonic",
      messageId: "wamid.agent-intercept",
      __tryHandlePaMissingInfoCustomerClarificationFn: async () => ({
        handled: true,
        reason: "OWNER_CLARIFICATION_RELAY_SENT",
        requestId: REQUEST_ID,
        ownerNotifyProviderMessageId: "wamid.relay-agent",
      }),
      __decideCustomerTurnFn: async () => {
        decideCalled = true;
        return { ok: false };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "OWNER_CLARIFICATION_RELAY_SENT");
    assert.equal(decideCalled, false);
  });
});

test("classifier contract: clear final answer", async () => {
  const result = await classifyPaMissingInfoOwnerResponseKind({
    customerQuestion: "Gari kitni chali hui hai?",
    missingInfoType: "other",
    ownerMessage: "Civic ki 42000 km chali hui hai",
    __chatCompletionsCreateForTests: async () =>
      kindOpenAiResponse("final_answer", "usable mileage answer"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "final_answer");
  assert.equal(result.source, "openai");
});

test("classifier contract: clear clarification question", async () => {
  const result = await classifyPaMissingInfoOwnerResponseKind({
    customerQuestion: "Gari kitni chali hui hai?",
    missingInfoType: "other",
    ownerMessage: "Kon c gari ka poch ry ho?",
    __chatCompletionsCreateForTests: async () =>
      kindOpenAiResponse("clarification_question", "asking which car"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "clarification_question");
  assert.equal(result.source, "openai");
});

test("classifier failure/unclear does not send customer or close; request recoverable", async () => {
  const fake = createFakeDb();
  seed(fake);
  const customerSends = [];
  const ownerSends = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Hmm maybe something about the car",
      messageId: "wamid.owner-unclear-1",
      contextMessageId: NOTIFY_WAMID,
      // Real classifier path — no __classifyOwnerResponseKindFn stub.
      sendWhatsAppMessageFn: async (to, text) => {
        const digits = String(to).replace(/\D/g, "");
        if (digits === OWNER_PHONE) ownerSends.push({ to, text });
        else customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.unclear-out" };
      },
      __chatCompletionsCreateForTests: async () => {
        throw new Error("CLASSIFIER_DOWN");
      },
    });
    assert.equal(result.reason, "OWNER_RESPONSE_KIND_UNCLEAR");
    assert.equal(result.ownerResponseKind, "unclear");
    assert.equal(result.recoverable, true);
    assert.equal(result.customerFollowupSent, false);
    assert.equal(customerSends.length, 0);
    assert.equal(ownerSends.length, 1);
    assert.match(ownerSends[0].text, /Final answer/i);
    assert.match(ownerSends[0].text, /Follow-up question/i);
    assert.equal(
      ownerSends[0].text,
      PA_MISSING_INFO_OWNER_RESPONSE_KIND_CLARIFY
    );
    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "owner_notified");
    assert.notEqual(row.status, "closed");
    assert.notEqual(row.status, "awaiting_customer_clarification");
    assert.equal(row.ownerAnswer ?? null, null);
    assert.equal(row.ownerClarificationText ?? null, null);
  });
});

test("classifier unclear enum keeps request recoverable without guessing loop", async () => {
  const fake = createFakeDb();
  seed(fake);
  const customerSends = [];
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "See previous notes",
      messageId: "wamid.owner-unclear-2",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async (to, text) => {
        const digits = String(to).replace(/\D/g, "");
        if (digits !== OWNER_PHONE) customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.x" };
      },
      __chatCompletionsCreateForTests: async () =>
        kindOpenAiResponse("unclear", "ambiguous meaning"),
    });
    assert.equal(result.reason, "OWNER_RESPONSE_KIND_UNCLEAR");
    assert.equal(customerSends.length, 0);
    assert.equal(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status, "owner_notified");
  });
});

test("final-answer parity via real classifier closes only after successful customer delivery", async () => {
  const fake = createFakeDb();
  seed(fake);
  const sends = [];
  let classifyCalls = 0;
  let followupCalls = 0;
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Around 42000 km",
      messageId: "wamid.owner-final-parity",
      contextMessageId: NOTIFY_WAMID,
      // No __classifyOwnerResponseKindFn — exercise real classify + final path.
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-final-parity" };
      },
      __chatCompletionsCreateForTests: async (args) => {
        const sys = String(args?.messages?.[0]?.content ?? "");
        if (sys.includes("classify ONE owner")) {
          classifyCalls += 1;
          return kindOpenAiResponse("final_answer", "clear mileage");
        }
        followupCalls += 1;
        return followupOpenAiResponse("Civic ki mileage around 42000 km hai.");
      },
    });
    assert.equal(classifyCalls, 1);
    assert.equal(followupCalls, 1);
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_SENT");
    assert.equal(result.status, "closed");
    assert.equal(result.ownerResponseKind, "final_answer");
    assert.equal(sends.length, 1);
    assert.equal(phoneDigits(sends[0].to), CUSTOMER_PHONE);
    assert.equal(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status, "closed");
  });
});

test("final-answer parity: failed customer delivery does not close", async () => {
  const fake = createFakeDb();
  seed(fake);
  await withFlags(async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "45000 km",
      messageId: "wamid.owner-final-fail-parity",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("CUSTOMER_SEND_DOWN");
      },
      __chatCompletionsCreateForTests: async (args) => {
        const sys = String(args?.messages?.[0]?.content ?? "");
        if (sys.includes("classify ONE owner")) {
          return kindOpenAiResponse("final_answer", "clear");
        }
        return followupOpenAiResponse("Mileage 45000 km hai.");
      },
    });
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_FAILED");
    assert.equal(result.customerFollowupSent, false);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "customer_followup_failed"
    );
    assert.notEqual(fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status, "closed");
  });
});

test("no hardcoded customer clarification ACK or AMBIGUOUS exports", async () => {
  const mod = await import("../src/services/paMissingInfoOwnerAnswerService.js");
  assert.equal(typeof mod.PA_MISSING_INFO_CUSTOMER_CLARIFICATION_ACK, "undefined");
  assert.equal(
    typeof mod.PA_MISSING_INFO_CUSTOMER_CLARIFICATION_AMBIGUOUS,
    "undefined"
  );
});
