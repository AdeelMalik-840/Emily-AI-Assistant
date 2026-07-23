import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { isEmilyBusinessPaMissingInfoEnabled } = await import(
  "../src/brain/config/liveFeatureFlags.js"
);
const { resolveActiveCustomerBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);
const {
  handleCustomerBusinessPaInbound,
  classifyCustomerBusinessPaActionIntent,
} = await import("../src/services/customerBusinessPaAgentService.js");
const {
  findOpenPaMissingInfoRequest,
  PA_MISSING_INFO_TYPES,
} = await import("../src/services/paMissingInfoRequestService.js");
const { parseCustomerBusinessPaAiJson } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);

const BUSINESS_ID = "owner-pa-miss-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const BOOKING_ID = "bk_pa_miss_001";
const AVR_ID = "avr_pa_miss_001";

function withFlags({ pa = true, missingInfo = false }, fn) {
  const prevPa = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  const prevMiss = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  if (pa) process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  if (missingInfo) process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevPa === undefined) delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
      else process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = prevPa;
      if (prevMiss === undefined)
        delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
      else process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = prevMiss;
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
    seedBooking(businessId, bookingId, data) {
      ensureBusiness(businessId).bookings[bookingId] = { data: { ...data } };
    },
    seedAvailabilityRequest(businessId, requestId, data) {
      ensureBusiness(businessId).availabilityRequests[requestId] = {
        data: { ...data },
      };
    },
    setOwnerPhone(businessId, phone) {
      const b = ensureBusiness(businessId);
      b.data = {
        ...b.data,
        ownerNotificationPhone: phone,
      };
    },
    listMissingInfo(businessId) {
      return Object.entries(
        ensureBusiness(businessId).paMissingInfoRequests || {}
      ).map(([id, node]) => ({ id, ...(node.data || {}) }));
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

function baseApprovedBooking(overrides = {}) {
  return {
    id: BOOKING_ID,
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "civic-1",
    itemLabel: "Honda Civic 2026",
    itemName: "Honda Civic 2026",
    durationDays: 2,
    totalAmount: 16000,
    availabilityRequestId: AVR_ID,
    dmTargetPhone: CUSTOMER_PHONE,
    customerPhone: `+${CUSTOMER_PHONE}`,
    sourceParticipantPhone: `+${CUSTOMER_PHONE}`,
    ...overrides,
  };
}

function jsonAiReply({
  customerReply,
  needsFollowup = false,
  missingInfoType = null,
}) {
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            needsFollowup,
            missingInfoType,
          }),
        },
      },
    ],
  });
}

function seedActiveContext(fake, { advanceAmount = null } = {}) {
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  fake.seedAvailabilityRequest(BUSINESS_ID, AVR_ID, {
    requestId: AVR_ID,
    itemLabel: "Honda Civic 2026",
    requestedDuration: 2,
    priceQuote: { total: 16000, dailyRate: 8000 },
    status: "approved",
    customerConfirmationStatus: "confirmed",
    linkedBookingId: BOOKING_ID,
  });
  return async (p) => {
    const resolved = await resolveActiveCustomerBookingFacts({
      ...p,
      getBusinessProfileFn: async () => ({
        businessName: "Emily Cars",
        category: "car_rental",
        businessKnowledge: "Friendly staff.",
      }),
    });
    if (resolved.ok && resolved.facts?.known) {
      resolved.facts.known.advanceAmount = advanceAmount;
    }
    return resolved;
  };
}

test("missing-info flag defaults off", () => {
  const prev = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  try {
    assert.equal(isEmilyBusinessPaMissingInfoEnabled(), false);
  } finally {
    if (prev === undefined)
      delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
    else process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = prev;
  }
});

test("parse AI JSON shape", () => {
  const parsed = parseCustomerBusinessPaAiJson(
    JSON.stringify({
      customerReply: "Advance abhi confirm nahi hai.",
      needsFollowup: true,
      missingInfoType: "advance",
    })
  );
  assert.equal(parsed.customerReply, "Advance abhi confirm nahi hai.");
  assert.equal(parsed.needsFollowup, true);
  assert.equal(parsed.missingInfoType, "advance");
  assert.deepEqual(PA_MISSING_INFO_TYPES.includes("advance"), true);
});

test("missing advance with missing-info flag ON creates one request and notifies owner", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const ownerSends = [];
  const customerSends = [];

  await withFlags({ pa: true, missingInfo: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      messageId: "wamid.miss-1",
      sendWhatsAppMessageFn: async (to, text) => {
        if (String(to).includes(OWNER_PHONE) || to === OWNER_PHONE) {
          ownerSends.push({ to, text });
        } else {
          customerSends.push({ to, text });
        }
        return { ok: true, messages: [{ id: "wamid.out-1" }] };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance confirm karke batata hoon.",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.openaiUsed, true);
    assert.equal(result.reply, "Advance confirm karke batata hoon.");
    assert.equal(result.missingInfoEscalated, true);
    assert.ok(result.missingInfoRequestId);
    assert.equal(result.missingInfoType, "advance");
    assert.equal(result.ownerNotifyStatus, "sent");
    assert.equal(customerSends.length, 1);
    assert.equal(ownerSends.length, 1);
    assert.match(ownerSends[0].text, /missing info \(advance\)/i);
    assert.match(ownerSends[0].text, /Advance kitna dena hoga/);
    assert.match(ownerSends[0].text, new RegExp(result.missingInfoRequestId));

    const rows = fake.listMissingInfo(BUSINESS_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "owner_notified");
    assert.equal(rows[0].ownerNotifyStatus, "sent");
    assert.equal(rows[0].bookingId, BOOKING_ID);
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

test("duplicate missing advance does not create a second request", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: true }, async () => {
    const common = {
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance abhi confirm nahi — check karke batata hoon.",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
      sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true, messages: [{ id: "wamid.x" }] };
      },
    };

    const first = await handleCustomerBusinessPaInbound({
      ...common,
      messageId: "wamid.a",
    });
    const second = await handleCustomerBusinessPaInbound({
      ...common,
      messageId: "wamid.b",
    });

    assert.equal(first.missingInfoEscalated, true);
    assert.equal(second.missingInfoEscalated, false);
    assert.equal(second.missingInfoRequestId, first.missingInfoRequestId);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(ownerNotifyCalls, 1);

    const open = await findOpenPaMissingInfoRequest({
      db: fake.db,
      businessId: BUSINESS_ID,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
    });
    assert.ok(open);
  });
});

test("missing-info flag OFF creates no request and no owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: false }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      missingInfoEscalationEnabled: false,
      sendWhatsAppMessageFn: async (to, text) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        assert.doesNotMatch(text, /check\s*karke|confirm\s*karke\s*batata/i);
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance abhi confirm nahi hai.",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.missingInfoRequestId, null);
    assert.equal(ownerNotifyCalls, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.equal(result.reply, "Advance abhi confirm nahi hai.");
  });
});

test("known advance does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, { advanceAmount: 5000 });
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance 5,000 PKR hai.",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
  });
});

test("action intent kar do does not escalate or call OpenAI", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  let openaiCalls = 0;
  let createCalled = false;

  assert.equal(classifyCustomerBusinessPaActionIntent("kar do").isAction, true);

  await withFlags({ pa: true, missingInfo: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "kar do",
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
      __resolveActiveCustomerBookingFactsFn: async (p) =>
        resolveActiveCustomerBookingFacts({
          ...p,
          getBusinessProfileFn: async () => ({}),
        }),
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        return { choices: [{ message: { content: "{}" } }] };
      },
    });

    assert.equal(result.handled, false);
    assert.equal(result.reason, "ACTION_INTENT");
    assert.equal(openaiCalls, 0);
    assert.equal(createCalled, false);
    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
  });
});

test("no canned HOLD_REPLIES or topic reply maps in PA modules", async () => {
  const agent = await import("../src/services/customerBusinessPaAgentService.js");
  const ai = await import("../src/services/customerBusinessPaAiReply.js");
  assert.equal("HOLD_REPLIES" in agent, false);
  assert.equal("HOLD_REPLIES" in ai, false);
  assert.equal(typeof agent.buildCustomerBusinessPaPr1Reply, "undefined");
  assert.equal(typeof agent.classifyPaQuestionTopic, "undefined");
});
