import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { isEmilyBusinessPaAgentEnabled } = await import(
  "../src/brain/config/liveFeatureFlags.js"
);
const { resolveActiveCustomerBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);
const {
  CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
  generateCustomerBusinessPaReplyFromFacts,
  __compactCustomerBusinessPaFactsForTests,
} = await import("../src/services/customerBusinessPaAiReply.js");
const {
  tryHandleCustomerBusinessPaInbound,
  handleCustomerBusinessPaInbound,
  classifyCustomerBusinessPaActionIntent,
} = await import("../src/services/customerBusinessPaAgentService.js");
const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} = await import("../src/services/whatsappInboundBuffer.js");

const BUSINESS_ID = "owner-business-pa-1";
const OTHER_BUSINESS_ID = "owner-business-pa-other";
const CUSTOMER_PHONE = "923001111111";
const BOOKING_ID = "bk_pa_001";
const AVR_ID = "avr_pa_001";

function withFlag(enabled, fn) {
  const prev = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  if (enabled) process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";
  else delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
      else process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = prev;
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

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
  };

  function seedBooking(businessId, bookingId, data) {
    ensureBusiness(businessId).bookings[bookingId] = { data: { ...data } };
  }

  function seedAvailabilityRequest(businessId, requestId, data) {
    ensureBusiness(businessId).availabilityRequests[requestId] = {
      data: { ...data },
    };
  }

  function getBooking(businessId, bookingId) {
    return store.businesses[businessId]?.bookings?.[bookingId]?.data ?? null;
  }

  return {
    db,
    store,
    seedBooking,
    seedAvailabilityRequest,
    getBooking,
    ensureBusiness,
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
    createdAt: new Date("2026-07-20T10:00:00Z"),
    updatedAt: new Date("2026-07-20T10:05:00Z"),
    ...overrides,
  };
}

function mockOpenAiReply(text) {
  return async () => ({
    choices: [{ message: { content: text } }],
  });
}

test("feature flag defaults off", () => {
  const prev = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  try {
    assert.equal(isEmilyBusinessPaAgentEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
    else process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = prev;
  }
});

test("flag off → PA not handled", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  let openaiCalls = 0;
  await withFlag(false, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        return { choices: [{ message: { content: "should not run" } }] };
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "FLAG_OFF");
    assert.equal(openaiCalls, 0);
    assert.equal(
      await tryHandleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: "Advance kitna?",
        sendWhatsAppMessageFn: async () => ({ ok: true }),
      }),
      null
    );
  });
});

test("no active booking → PA not handled", async () => {
  const fake = createFakeDb();
  await withFlag(true, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __chatCompletionsCreateForTests: mockOpenAiReply("x"),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "NO_ACTIVE_BOOKING");
  });
});

test("ambiguous active bookings → PA not handled", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, "bk_a", baseApprovedBooking({ id: "bk_a" }));
  fake.seedBooking(BUSINESS_ID, "bk_b", baseApprovedBooking({ id: "bk_b" }));
  await withFlag(true, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __chatCompletionsCreateForTests: mockOpenAiReply("x"),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "AMBIGUOUS_BOOKINGS");
  });
});

test("cancelled/completed booking → PA not handled", async () => {
  const fake = createFakeDb();
  fake.seedBooking(
    BUSINESS_ID,
    BOOKING_ID,
    baseApprovedBooking({ status: "cancelled" })
  );
  await withFlag(true, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __chatCompletionsCreateForTests: mockOpenAiReply("x"),
    });
    assert.equal(result.handled, false);
  });
});

test("same phone other business → no match", async () => {
  const fake = createFakeDb();
  fake.seedBooking(OTHER_BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  const resolved = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({ businessName: "X" }),
  });
  assert.equal(resolved.ok, false);
});

test("facts helper: shapes for no booking / ambiguous / AVR missing", async () => {
  const fake = createFakeDb();
  const none = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(none.ok, false);
  assert.equal(none.reason, "NO_ACTIVE_BOOKING");

  fake.seedBooking(BUSINESS_ID, "bk_a", baseApprovedBooking({ id: "bk_a" }));
  fake.seedBooking(BUSINESS_ID, "bk_b", baseApprovedBooking({ id: "bk_b" }));
  const amb = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(amb.ok, false);
  assert.equal(amb.reason, "AMBIGUOUS_BOOKINGS");

  const fake2 = createFakeDb();
  fake2.seedBooking(
    BUSINESS_ID,
    BOOKING_ID,
    baseApprovedBooking({ availabilityRequestId: "avr_missing" })
  );
  const okMissingAvr = await resolveActiveCustomerBookingFacts({
    db: fake2.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({
      businessName: "Emily Rentals",
      businessKnowledge: "Friendly tone.",
    }),
  });
  assert.equal(okMissingAvr.ok, true);
  assert.equal(okMissingAvr.facts.availabilityRequest, null);
  assert.equal(okMissingAvr.facts.business.name, "Emily Rentals");
  assert.equal(okMissingAvr.facts.booking.id, BOOKING_ID);
  assert.equal(okMissingAvr.facts.policy.readOnly, true);
});

test("active booking + hello → OpenAI called; reply equals mock", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  let openaiCalls = 0;
  let lastPayload = "";
  const mockReply = "Ji bolo, kaise help karun?";
  await withFlag(true, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "hello",
      sendWhatsAppMessageFn: async (_p, text) => {
        assert.equal(text, mockReply);
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: async (p) =>
        resolveActiveCustomerBookingFacts({
          ...p,
          getBusinessProfileFn: async () => ({
            businessName: "Emily Cars",
            businessKnowledge: "Friendly.",
          }),
        }),
      __chatCompletionsCreateForTests: async (args) => {
        openaiCalls += 1;
        lastPayload = JSON.stringify(args);
        return { choices: [{ message: { content: mockReply } }] };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reply, mockReply);
    assert.equal(result.openaiUsed, true);
    assert.equal(openaiCalls, 1);
    assert.doesNotMatch(result.reply, /Advance mai btata hun/i);
    assert.doesNotMatch(lastPayload, /HOLD_REPLIES/);
  });
});

test("Advance / Driver / Rent questions call OpenAI with Brain facts", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  fake.seedAvailabilityRequest(BUSINESS_ID, AVR_ID, {
    requestId: AVR_ID,
    itemLabel: "Honda Civic 2026",
    requestedDuration: 2,
    priceQuote: { total: 16000 },
  });

  async function runMsg(message) {
    let openaiCalls = 0;
    let userContent = "";
    const mockReply = `natural:${message}`;
    const result = await withFlag(true, async () =>
      handleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: message,
        sendWhatsAppMessageFn: async () => ({ ok: true }),
        __resolveActiveCustomerBookingFactsFn: async (p) =>
          resolveActiveCustomerBookingFacts({
            ...p,
            getBusinessProfileFn: async () => ({
              businessName: "Emily Cars",
              category: "car_rental",
              businessKnowledge: "Customer friendly.",
            }),
          }),
        __chatCompletionsCreateForTests: async (args) => {
          openaiCalls += 1;
          userContent = String(args?.messages?.[1]?.content ?? "");
          return { choices: [{ message: { content: mockReply } }] };
        },
      })
    );
    return { result, openaiCalls, userContent, mockReply };
  }

  const advance = await runMsg("Advance kitna?");
  assert.equal(advance.result.handled, true);
  assert.equal(advance.openaiCalls, 1);
  assert.equal(advance.result.reply, advance.mockReply);
  assert.match(advance.userContent, /VERIFIED_BUSINESS_PA_FACTS_JSON/);
  assert.match(advance.userContent, /Emily Cars/);
  assert.match(advance.userContent, /bk_pa_001|Honda Civic/);

  const driver = await runMsg("Driver milega?");
  assert.equal(driver.openaiCalls, 1);
  assert.equal(driver.result.reply, driver.mockReply);

  const rent = await runMsg("Rent kitna bana?");
  assert.equal(rent.openaiCalls, 1);
  assert.equal(rent.result.reply, rent.mockReply);
  assert.match(rent.userContent, /16000|totalAmount/);
  assert.doesNotMatch(rent.result.reply, /Advance mai btata hun/i);
});

test("normal path does not use canned HOLD / topic table", async () => {
  assert.equal(
    typeof (await import("../src/services/customerBusinessPaAgentService.js"))
      .buildCustomerBusinessPaPr1Reply,
    "undefined"
  );
  const mod = await import("../src/services/customerBusinessPaAgentService.js");
  assert.equal("HOLD_REPLIES" in mod, false);
});

test("action intents do not call OpenAI", async () => {
  assert.equal(classifyCustomerBusinessPaActionIntent("kar do").isAction, true);
  assert.equal(
    classifyCustomerBusinessPaActionIntent("cancel booking").isAction,
    true
  );
  assert.equal(
    classifyCustomerBusinessPaActionIntent("4 din ki jagah 5 din kar do").isAction,
    true
  );

  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  for (const message of ["kar do", "cancel booking"]) {
    let openaiCalls = 0;
    let sends = 0;
    await withFlag(true, async () => {
      const result = await handleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: message,
        sendWhatsAppMessageFn: async () => {
          sends += 1;
          return { ok: true };
        },
        __resolveActiveCustomerBookingFactsFn: async (p) =>
          resolveActiveCustomerBookingFacts({
            ...p,
            getBusinessProfileFn: async () => ({}),
          }),
        __chatCompletionsCreateForTests: async () => {
          openaiCalls += 1;
          return { choices: [{ message: { content: "nope" } }] };
        },
      });
      assert.equal(result.handled, false);
      assert.equal(result.reason, "ACTION_INTENT");
      assert.equal(openaiCalls, 0);
      assert.equal(sends, 0);
      assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
    });
  }
});

test("OpenAI failure → one technical fallback; handled true", async () => {
  const fake = createFakeDb();
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  let sent = "";
  await withFlag(true, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendWhatsAppMessageFn: async (_p, text) => {
        sent = text;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: async (p) =>
        resolveActiveCustomerBookingFacts({
          ...p,
          getBusinessProfileFn: async () => ({}),
        }),
      __chatCompletionsCreateForTests: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.openaiUsed, false);
    assert.equal(sent, CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK);
    assert.equal(result.reply, CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK);
  });
});

test("OpenAI helper compact facts include booking total + linked AVR", async () => {
  const compact = __compactCustomerBusinessPaFactsForTests({
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Cars", category: "rental", tone: null, instructions: "hi" },
    booking: {
      id: BOOKING_ID,
      itemLabel: "Honda Civic 2026",
      durationDays: 2,
      totalAmount: 16000,
      availabilityRequestId: AVR_ID,
    },
    availabilityRequest: {
      id: AVR_ID,
      itemLabel: "Honda Civic 2026",
      requestedDuration: 2,
      priceQuote: { total: 16000 },
    },
    known: { totalAmount: 16000, itemLabel: "Honda Civic 2026" },
    policy: { readOnly: true, doNotInventAmounts: true, doNotMutateBooking: true },
  });
  assert.match(compact, /16000/);
  assert.match(compact, /Honda Civic/);
  assert.match(compact, /avr_pa_001/);

  const ai = await generateCustomerBusinessPaReplyFromFacts({
    facts: JSON.parse(compact),
    userMessage: "Rent kitna?",
    __chatCompletionsCreateForTests: mockOpenAiReply("16000 total tha."),
  });
  assert.equal(ai.ok, true);
  assert.equal(ai.reply, "16000 total tha.");
});

test("buffer: PA handled skips Brain and sendVia NONE", async () => {
  __clearWhatsAppInboundBufferForTests?.();
  let brainV2Calls = 0;
  let processCalls = 0;
  let paCalls = 0;
  let confirmCalls = 0;
  let outcome = null;

  const prevLive = process.env.EMILY_BRAIN_V2_LIVE;
  const prevBiz = process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES;
  const prevAllow = process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";

  try {
    const msg = `Advance kitna? [test:${randomUUID()}]`;
    await executeWhatsAppAiPipeline({
      db: createFakeDb().db,
      ownerUserId: BUSINESS_ID,
      userPhone: CUSTOMER_PHONE,
      conversationCustomerNumber: CUSTOMER_PHONE,
      participantPhoneForDm: CUSTOMER_PHONE,
      sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}::${randomUUID()}`,
      sendCredentials: { accessToken: "t", phoneNumberId: "1" },
      isGroupMessage: false,
      playwrightWebInbound: false,
      combinedMessage: msg,
      latestMessage: msg,
      messageId: `wamid.pa-${randomUUID()}`,
      __tryHandleAvailabilityCustomerCloudInboundFn: async () => {
        confirmCalls += 1;
        return null;
      },
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return {
          handled: true,
          action: "business_pa_reply",
          reply: "natural openai reply",
          bookingId: BOOKING_ID,
          openaiUsed: true,
        };
      },
      __tryBrainV2LiveBeforeLegacyFn: async () => {
        brainV2Calls += 1;
        return {
          handled: true,
          legacyBypassed: true,
          reply: "Main samajh nahi paaya.",
          sendVia: "CLOUD_API",
        };
      },
      __processMessageFn: async () => {
        processCalls += 1;
        return { reply: "legacy", sendVia: "CLOUD_API" };
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

  assert.equal(confirmCalls, 1);
  assert.equal(paCalls, 1);
  assert.equal(brainV2Calls, 0);
  assert.equal(processCalls, 0);
  assert.equal(outcome?.sendVia, "NONE");
  assert.equal(outcome?.messageMeta?.customerBusinessPaHandled, true);
});

test("buffer: waiting_confirm kar do still confirm before PA", async () => {
  __clearWhatsAppInboundBufferForTests?.();
  let paCalls = 0;
  let confirmCalls = 0;
  let brainV2Calls = 0;
  let outcome = null;

  const prevLive = process.env.EMILY_BRAIN_V2_LIVE;
  const prevBiz = process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES;
  const prevAllow = process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";

  try {
    const msg = `Kar do [test:${randomUUID()}]`;
    await executeWhatsAppAiPipeline({
      db: createFakeDb().db,
      ownerUserId: BUSINESS_ID,
      userPhone: CUSTOMER_PHONE,
      conversationCustomerNumber: CUSTOMER_PHONE,
      participantPhoneForDm: CUSTOMER_PHONE,
      sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}::${randomUUID()}`,
      sendCredentials: { accessToken: "t", phoneNumberId: "1" },
      isGroupMessage: false,
      playwrightWebInbound: false,
      combinedMessage: msg,
      latestMessage: msg,
      messageId: `wamid.pa-confirm-${randomUUID()}`,
      __tryHandleAvailabilityCustomerCloudInboundFn: async () => {
        confirmCalls += 1;
        return {
          handled: true,
          action: "confirmed_booking",
          reply: "Booking confirm ho gayi.",
          requestId: AVR_ID,
        };
      },
      __tryHandleCustomerBusinessPaInboundFn: async () => {
        paCalls += 1;
        return { handled: true, reply: "should not run", bookingId: BOOKING_ID };
      },
      __tryBrainV2LiveBeforeLegacyFn: async () => {
        brainV2Calls += 1;
        return { handled: true, legacyBypassed: true, reply: "brain" };
      },
      __processMessageFn: async () => ({ reply: "legacy", sendVia: "CLOUD_API" }),
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

  assert.equal(confirmCalls, 1);
  assert.equal(paCalls, 0);
  assert.equal(brainV2Calls, 0);
  assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
  assert.equal(outcome?.messageMeta?.customerBusinessPaHandled, undefined);
});

test("messageProcessor and Brain workflows remain free of PA imports", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(process.cwd());
  const mp = readFileSync(join(root, "src/services/messageProcessor.js"), "utf8");
  assert.doesNotMatch(mp, /customerBusinessPa/);
  const clar = readFileSync(
    join(root, "src/brain/workflows/ClarificationWorkflow.js"),
    "utf8"
  );
  assert.doesNotMatch(clar, /customerBusinessPa/);
  const router = readFileSync(join(root, "src/brain/live/actionRouter.js"), "utf8");
  assert.doesNotMatch(router, /customerBusinessPa/);
});
