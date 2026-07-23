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
  isPaMissingInfoFactMissing,
  PA_MISSING_INFO_TYPES,
} = await import("../src/services/paMissingInfoRequestService.js");
const {
  composeDeliveryPolicyFromLogistics,
  resolveBusinessProfileFacts,
} = await import("../src/brain/facts/resolveBusinessProfileFacts.js");
const { parseCustomerBusinessPaAiJson } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);

const BUSINESS_ID = "owner-pa-miss-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const BOOKING_ID = "bk_pa_miss_001";
const AVR_ID = "avr_pa_miss_001";

function withFlags({ pa = true, missingInfo = false, ownerAnswer = false }, fn) {
  const prevPa = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  const prevMiss = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevAns = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  if (pa) process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  if (missingInfo) process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  if (ownerAnswer)
    process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevPa === undefined) delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
      else process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = prevPa;
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
  conversationAct = null,
  customerIsAskingQuestion = null,
  action = null,
  situation = null,
}) {
  const escalate = needsFollowup === true && Boolean(missingInfoType);
  const act =
    conversationAct ||
    (escalate ? "information_request" : "acknowledgement");
  const asking =
    customerIsAskingQuestion != null
      ? customerIsAskingQuestion
      : escalate;
  const decisionAction =
    action || (escalate ? "escalate_missing_info" : "reply");
  const situationValue =
    situation ||
    (escalate
      ? "new_question"
      : act === "acknowledgement" || act === "thanks"
        ? "acknowledgement_after_answer"
        : "unclear");
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            situation: situationValue,
            conversationAct: act,
            customerIsAskingQuestion: asking,
            requestedInfoType: escalate ? missingInfoType : null,
            customerReply,
            action: decisionAction,
            // legacy fields ignored for escalate by executor
            needsFollowup,
            missingInfoType,
          }),
        },
      },
    ],
  });
}

function seedActiveContext(fake, opts = {}) {
  const {
    profile = {
      businessName: "Emily Cars",
      category: "car_rental",
      businessKnowledge: "Friendly staff.",
    },
  } = opts;
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
      getBusinessProfileFn: async () => profile,
    });
    if (resolved.ok && resolved.facts?.known && "advanceAmount" in opts) {
      resolved.facts.known.advanceAmount = opts.advanceAmount;
      if (resolved.facts.business) {
        resolved.facts.business.advanceAmount = opts.advanceAmount;
      }
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
      situation: "new_question",
      conversationAct: "information_request",
      customerIsAskingQuestion: true,
      requestedInfoType: "advance",
      customerReply: "Advance abhi confirm nahi hai.",
      action: "escalate_missing_info",
    })
  );
  assert.equal(parsed.customerReply, "Advance abhi confirm nahi hai.");
  assert.equal(parsed.needsFollowup, true);
  assert.equal(parsed.missingInfoType, "advance");
  assert.equal(parsed.action, "escalate_missing_info");
  assert.equal(parsed.situation, "new_question");
  assert.deepEqual(PA_MISSING_INFO_TYPES.includes("advance"), true);
});

test("acknowledgement cannot escalate even if malformed model implies follow-up", () => {
  const parsed = parseCustomerBusinessPaAiJson(
    JSON.stringify({
      situation: "new_question",
      conversationAct: "acknowledgement",
      customerIsAskingQuestion: false,
      requestedInfoType: "advance",
      customerReply: "Ji theek hai.",
      action: "escalate_missing_info",
      needsFollowup: true,
      missingInfoType: "advance",
    })
  );
  assert.equal(parsed.conversationAct, "acknowledgement");
  assert.equal(parsed.action, "reply");
  assert.equal(parsed.needsFollowup, false);
  assert.equal(parsed.requestedInfoType, null);
  assert.equal(parsed.situation, "acknowledgement_after_answer");
});

test("missing advance with missing-info flag ON creates one request and notifies owner", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const ownerSends = [];
  const customerSends = [];

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
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

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
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
        situation: "new_question",
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
    // Second turn sees open request in Brain facts → pending; no new ledger row / notify.
    assert.equal(second.situation, "pending_owner_answer");
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

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
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

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
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
  assert.equal(typeof agent.PA_TOPIC_REPLY_MAP, "undefined");
  assert.equal(typeof ai.PA_TOPIC_REPLY_MAP, "undefined");
});

test("no PA-specific knowledge store module added", async () => {
  await assert.rejects(
    () => import("../src/services/paKnowledgeStore.js"),
    /Cannot find module|ERR_MODULE_NOT_FOUND/
  );
  await assert.rejects(
    () => import("../src/brain/facts/paKnowledgeStore.js"),
    /Cannot find module|ERR_MODULE_NOT_FOUND/
  );
});

test("logistics from business setup becomes known.deliveryPolicy", async () => {
  const composed = composeDeliveryPolicyFromLogistics({
    defaultPickupLocation: "Gulberg III office",
    pickupInstructions: "Call on arrival",
    pickupAvailableHours: "10am-8pm",
    deliveryCoverageAreas: ["Lahore", "DHA"],
    deliveryChargesNote: "City delivery 1500 PKR",
  });
  assert.match(composed, /Gulberg III office/);
  assert.match(composed, /Lahore/);
  assert.match(composed, /1500 PKR/);

  const profileSlice = await resolveBusinessProfileFacts("biz-1", async () => ({
    businessName: "Emily Cars",
    profileData: {
      businessName: "Emily Cars",
      logistics: {
        defaultPickupLocation: "Gulberg III office",
        pickupInstructions: "Call on arrival",
        pickupAvailableHours: "10am-8pm",
        deliveryCoverageAreas: ["Lahore", "DHA"],
        deliveryChargesNote: "City delivery 1500 PKR",
      },
    },
  }));
  assert.match(profileSlice.business.deliveryPolicy, /Pickup: Gulberg III office/);
  assert.equal(profileSlice.business.advanceAmount, null);
  assert.equal(profileSlice.business.advancePolicy, null);

  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  const resolved = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({
      businessName: "Emily Cars",
      profileData: {
        logistics: {
          defaultPickupLocation: "Gulberg III office",
          deliveryCoverageAreas: ["Lahore"],
          deliveryChargesNote: "City delivery 1500 PKR",
        },
      },
    }),
  });
  assert.equal(resolved.ok, true);
  assert.match(resolved.facts.known.deliveryPolicy, /Gulberg III office/);
  assert.equal(
    resolved.facts.known.deliveryPolicy,
    resolved.facts.business.deliveryPolicy
  );
  assert.equal(isPaMissingInfoFactMissing(resolved.facts, "delivery"), false);
  assert.equal(isPaMissingInfoFactMissing(resolved.facts, "advance"), true);
});

test("delivery question does not escalate when deliveryPolicy exists", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, {
    profile: {
      businessName: "Emily Cars",
      category: "car_rental",
      profileData: {
        logistics: {
          defaultPickupLocation: "Johar Town",
          deliveryCoverageAreas: ["Lahore"],
        },
      },
    },
  });
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Delivery available hai?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Pickup Johar Town se hai, Lahore delivery cover hai.",
        needsFollowup: true,
        missingInfoType: "delivery",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
  });
});

test("advance still escalates when no advanceAmount/advancePolicy", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, {
    profile: {
      businessName: "Emily Cars",
      profileData: {
        logistics: { defaultPickupLocation: "Office" },
      },
    },
  });
  const ownerSends = [];

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async (to, text) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) {
          ownerSends.push({ to, text });
        }
        return { ok: true, messages: [{ id: "wamid.out" }] };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance confirm karke batata hoon.",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.missingInfoType, "advance");
    assert.equal(ownerSends.length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("advance does not escalate when advancePolicy exists", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, {
    profile: {
      businessName: "Emily Cars",
      profileData: {
        advancePolicy: "50% advance booking confirm par.",
      },
    },
  });
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
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
        customerReply: "Advance 50% booking confirm par hota hai.",
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

test("compact AI facts JSON includes known policy fields", async () => {
  const { __compactCustomerBusinessPaFactsForTests } = await import(
    "../src/services/customerBusinessPaAiReply.js"
  );
  const compact = __compactCustomerBusinessPaFactsForTests({
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: {
      name: "Emily Cars",
      deliveryPolicy: "Pickup: Office.",
      advancePolicy: "50% advance",
    },
    booking: { id: BOOKING_ID, status: "approved" },
    known: {
      deliveryPolicy: "Pickup: Office.",
      advancePolicy: "50% advance",
      driverPolicy: "Driver optional",
      paymentPolicy: "Cash/JazzCash",
      documentsPolicy: "CNIC required",
      advanceAmount: null,
    },
    policy: { readOnly: true },
  });
  assert.match(compact, /"deliveryPolicy":"Pickup: Office\."/);
  assert.match(compact, /"advancePolicy":"50% advance"/);
  assert.match(compact, /"driverPolicy":"Driver optional"/);
  assert.match(compact, /"paymentPolicy":"Cash\/JazzCash"/);
  assert.match(compact, /"documentsPolicy":"CNIC required"/);
});

test("Brain decision helper lives under src/brain/decisions", async () => {
  const mod = await import(
    "../src/brain/decisions/decidePostConfirmCustomerDm.js"
  );
  assert.equal(typeof mod.decidePostConfirmCustomerDm, "function");
  assert.equal(typeof mod.canEscalatePostConfirmMissingInfo, "function");
  assert.equal(typeof mod.parsePostConfirmCustomerDmDecision, "function");
  assert.ok(mod.POST_CONFIRM_SITUATIONS.includes("new_question"));
  assert.ok(
    mod.POST_CONFIRM_SITUATIONS.includes("acknowledgement_after_answer")
  );
});

test("OK after customerFollowupText → acknowledgement_after_answer, no request/notify", async () => {
  const fake = createFakeDb();
  const now = new Date();
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
  fake.ensureBusiness(BUSINESS_ID).paMissingInfoRequests[
    "pamiss_closed_adv_001"
  ] = {
    data: {
      requestId: "pamiss_closed_adv_001",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
      customerQuestion: "Advance kitna?",
      ownerAnswer: "5000",
      customerFollowupText: "Advance 5000 PKR dena hoga.",
      customerFollowupStatus: "sent",
      status: "closed",
      closedAt: now,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  };
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const facts = await resolveActiveCustomerBookingFacts({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      getBusinessProfileFn: async () => ({ businessName: "Emily Cars" }),
    });
    assert.equal(facts.facts.latestClosedMissingInfoAnswers.length, 1);
    assert.equal(
      facts.facts.latestClosedMissingInfoAnswers[0].customerFollowupText,
      "Advance 5000 PKR dena hoga."
    );

    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "OK",
      sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Ji theek hai.",
        conversationAct: "acknowledgement",
        customerIsAskingQuestion: false,
        action: "reply",
        situation: "acknowledgement_after_answer",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.situation, "acknowledgement_after_answer");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(ownerNotifyCalls, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
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

test("thanks after customerFollowupText exists → no escalation", async () => {
  const fake = createFakeDb();
  const now = new Date();
  const resolveFacts = seedActiveContext(fake);
  fake.ensureBusiness(BUSINESS_ID).paMissingInfoRequests["pamiss_thanks"] = {
    data: {
      requestId: "pamiss_thanks",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
      ownerAnswer: "5000",
      customerFollowupText: "Advance 5000 PKR dena hoga.",
      customerFollowupStatus: "sent",
      status: "closed",
      closedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "thanks",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Welcome ji.",
        conversationAct: "thanks",
        customerIsAskingQuestion: false,
        action: "escalate_missing_info",
        situation: "new_question",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(result.situation, "acknowledgement_after_answer");
  });
});

test("ok driver milega? → new_question information_request can escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const ownerSends = [];

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "ok driver milega?",
      sendWhatsAppMessageFn: async (to, text) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) {
          ownerSends.push(text);
        }
        return { ok: true, messages: [{ id: "wamid.o" }] };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Driver confirm karke batata hoon.",
        conversationAct: "information_request",
        customerIsAskingQuestion: true,
        missingInfoType: "driver",
        needsFollowup: true,
        action: "escalate_missing_info",
        situation: "new_question",
      }),
    });

    assert.equal(result.situation, "new_question");
    assert.equal(result.conversationAct, "information_request");
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.missingInfoType, "driver");
    assert.equal(ownerSends.length, 1);
    assert.match(ownerSends[0], /pamiss_/);
  });
});

test("Advance kitna? after ownerAnswer+followup → repeat_question_answered, no escalate", async () => {
  const fake = createFakeDb();
  const now = new Date();
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
  fake.ensureBusiness(BUSINESS_ID).paMissingInfoRequests["pamiss_closed_5000"] = {
    data: {
      requestId: "pamiss_closed_5000",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
      customerQuestion: "Advance kitna?",
      ownerAnswer: "5000",
      customerFollowupText: "Advance 5000 PKR dena hoga.",
      customerFollowupStatus: "sent",
      status: "closed",
      closedAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };

  let createCalled = false;
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const facts = await resolveActiveCustomerBookingFacts({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      getBusinessProfileFn: async () => ({ businessName: "Emily Cars" }),
    });
    assert.equal(facts.ok, true);
    assert.equal(facts.facts.known.advanceAmount, 5000);
    assert.equal(facts.facts.latestClosedMissingInfoAnswers[0].ownerAnswer, "5000");

    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance 5000 PKR dena hoga.",
        conversationAct: "information_request",
        customerIsAskingQuestion: true,
        action: "reply",
        situation: "repeat_question_answered",
        missingInfoType: null,
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.situation, "repeat_question_answered");
    assert.equal(result.reply, "Advance 5000 PKR dena hoga.");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
  });
});

test("same missing type while request open → no duplicate request", async () => {
  const fake = createFakeDb();
  const now = new Date();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  fake.ensureBusiness(BUSINESS_ID).paMissingInfoRequests["pamiss_open_adv"] = {
    data: {
      requestId: "pamiss_open_adv",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
      customerQuestion: "Advance kitna?",
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };
  let createCalled = false;
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const facts = await resolveActiveCustomerBookingFacts({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      getBusinessProfileFn: async () => ({ businessName: "Emily Cars" }),
    });
    assert.equal(facts.facts.openMissingInfoRequests.length, 1);
    assert.equal(facts.facts.openMissingInfoRequests[0].missingInfoType, "advance");

    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Abhi confirm kar raha hun.",
        conversationAct: "information_request",
        customerIsAskingQuestion: true,
        needsFollowup: true,
        missingInfoType: "advance",
        action: "escalate_missing_info",
        situation: "new_question",
      }),
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(ownerNotifyCalls, 0);
    assert.equal(result.situation, "pending_owner_answer");
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("new missing advance with no open/closed answer → escalate still works", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true, messages: [{ id: "wamid.z" }] };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Advance confirm karke batata hoon.",
        needsFollowup: true,
        missingInfoType: "advance",
        situation: "new_question",
      }),
    });

    assert.equal(result.situation, "new_question");
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(ownerNotifyCalls, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("unclear message → no dangerous action / no owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let createCalled = false;
  let ownerNotifyCalls = 0;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "hmm",
      sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Ji bataiye?",
        conversationAct: "unknown",
        customerIsAskingQuestion: false,
        action: "escalate_missing_info",
        situation: "unclear",
        needsFollowup: true,
        missingInfoType: "advance",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.situation, "unclear");
    assert.equal(result.decisionAction, "reply");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(ownerNotifyCalls, 0);
    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
  });
});

test("missing-info ON but owner-answer OFF does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: false }, async () => {
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
        customerReply: "Advance abhi confirm nahi hai.",
        needsFollowup: true,
        missingInfoType: "advance",
        situation: "new_question",
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
  });
});

test("compact facts include open/closed missing-info situation", async () => {
  const { __compactCustomerBusinessPaFactsForTests } = await import(
    "../src/services/customerBusinessPaAiReply.js"
  );
  const compact = __compactCustomerBusinessPaFactsForTests({
    businessId: BUSINESS_ID,
    known: { advanceAmount: 5000 },
    booking: { id: BOOKING_ID },
    openMissingInfoRequests: [
      {
        requestId: "pamiss_open",
        missingInfoType: "driver",
        customerQuestion: "Driver?",
        status: "open",
        createdAt: "2026-07-23T00:00:00.000Z",
        ownerNotifyStatus: "sent",
      },
    ],
    latestClosedMissingInfoAnswers: [
      {
        requestId: "pamiss_closed",
        missingInfoType: "advance",
        customerQuestion: "Advance kitna?",
        ownerAnswer: "5000",
        customerFollowupText: "Advance 5000 PKR dena hoga.",
        customerFollowupStatus: "sent",
        closedAt: "2026-07-23T01:00:00.000Z",
      },
    ],
  });
  assert.match(compact, /"openMissingInfoRequests"/);
  assert.match(compact, /"latestClosedMissingInfoAnswers"/);
  assert.match(compact, /"customerFollowupText":"Advance 5000 PKR dena hoga\."/);
  assert.match(compact, /"missingInfoType":"driver"/);
});

test("no PA knowledge store and decision under brain/decisions", async () => {
  await assert.rejects(
    () => import("../src/services/paKnowledgeStore.js"),
    /Cannot find module|ERR_MODULE_NOT_FOUND/
  );
  const agent = await import("../src/services/customerBusinessPaAgentService.js");
  assert.equal(typeof agent.HOLD_REPLIES, "undefined");
  assert.equal(typeof agent.PA_TOPIC_REPLY_MAP, "undefined");
});
