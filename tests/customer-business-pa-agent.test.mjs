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
} = await import("../src/services/customerBusinessPaAgentService.js");
const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} = await import("../src/services/whatsappInboundBuffer.js");
const {
  buildCloudInboundLifecycleIdentity,
  getInboundTurnLedgerEntry,
} = await import("../src/services/inboundTurnLedger.js");

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
    choices: [
      {
        message: {
          content: JSON.stringify({
            situation: "new_question",
            conversationAct: "information_request",
            customerIntent: "ask_fact",
            customerIsAskingQuestion: true,
            requestedInfoType: null,
            shouldReply: true,
            customerReply: text,
            action: "reply",
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
  });
}

function mockOpenAiSocialReply(text) {
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            situation: "acknowledgement_after_answer",
            conversationAct: "chit_chat",
            customerIntent: "ack",
            customerIsAskingQuestion: false,
            requestedInfoType: null,
            shouldReply: true,
            customerReply: text,
            action: "reply",
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

test("flag off → confirmed-booking continuity still uses OpenAI", async () => {
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
    assert.equal(result.handled, true);
    assert.equal(result.reason, "HANDLED");
    assert.equal(result.finalReplySource, "openai_post_confirm_pa");
    assert.equal(openaiCalls, 1);
    assert.equal(
      (
        await tryHandleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: "Advance kitna?",
        sendWhatsAppMessageFn: async () => ({ ok: true }),
        __chatCompletionsCreateForTests: mockOpenAiReply("Verified reply"),
      })
      )?.handled,
      true
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

test("ambiguous active bookings → same OpenAI lane owns safe clarification", async () => {
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
    assert.equal(result.handled, true);
    assert.equal(result.bookingId, null);
    assert.equal(result.finalReplySource, "openai_post_confirm_pa");
  });
});

test("booking continuity has no one-hour timeout and ends for every terminal status", async () => {
  const active = createFakeDb();
  active.seedBooking(
    BUSINESS_ID,
    BOOKING_ID,
    baseApprovedBooking({
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 90 * 60 * 1000),
    })
  );
  const activeResolved = await resolveActiveCustomerBookingFacts({
    db: active.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
  });
  assert.equal(activeResolved.ok, true);
  assert.equal(activeResolved.reason, "MATCHED");

  for (const status of [
    "cancelled",
    "canceled",
    "completed",
    "closed",
    "expired",
    "rejected",
    "declined",
  ]) {
    const terminal = createFakeDb();
    terminal.seedBooking(
      BUSINESS_ID,
      `${BOOKING_ID}-${status}`,
      baseApprovedBooking({ id: `${BOOKING_ID}-${status}`, status })
    );
    const resolved = await resolveActiveCustomerBookingFacts({
      db: terminal.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });
    assert.equal(resolved.ok, false, status);
    assert.equal(resolved.reason, "NO_ACTIVE_BOOKING", status);
  }
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

test("same business other customer → no match", async () => {
  const fake = createFakeDb();
  fake.seedBooking(
    BUSINESS_ID,
    BOOKING_ID,
    baseApprovedBooking({
      customerPhone: "923009999999",
      dmTargetPhone: "923009999999",
      sourceParticipantPhone: "923009999999",
    })
  );
  const resolved = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({ businessName: "X" }),
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "NO_ACTIVE_BOOKING");
});

test("customer identity never matches a different valid phone that is only a suffix", async () => {
  const fake = createFakeDb();
  fake.seedBooking(
    BUSINESS_ID,
    BOOKING_ID,
    baseApprovedBooking({
      customerPhone: "3001111111",
      dmTargetPhone: "3001111111",
      sourceParticipantPhone: "3001111111",
    })
  );
  const resolved = await resolveActiveCustomerBookingFacts({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    getBusinessProfileFn: async () => ({ businessName: "X" }),
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "NO_ACTIVE_BOOKING");
});

test("linked AVR facts are used only for the exact active booking lifecycle", async () => {
  const cases = [
    {
      name: "trusted current",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        linkedBookingId: BOOKING_ID,
        status: "approved",
        customerConfirmationStatus: "confirmed",
      },
      expectedLoaded: true,
    },
    {
      name: "other customer",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: "923009999999",
        linkedBookingId: BOOKING_ID,
        status: "approved",
        customerConfirmationStatus: "confirmed",
      },
      expectedLoaded: false,
    },
    {
      name: "other booking",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        linkedBookingId: "bk_other",
        status: "approved",
        customerConfirmationStatus: "confirmed",
      },
      expectedLoaded: false,
    },
    {
      name: "superseded",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        linkedBookingId: BOOKING_ID,
        status: "approved",
        customerConfirmationStatus: "confirmed",
        supersededByAvailabilityRequestId: "avr_new",
      },
      expectedLoaded: false,
    },
    {
      name: "rejected",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        linkedBookingId: BOOKING_ID,
        status: "rejected",
        customerConfirmationStatus: "confirmed",
      },
      expectedLoaded: false,
    },
    {
      name: "not confirmed",
      request: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        linkedBookingId: BOOKING_ID,
        status: "approved",
        customerConfirmationStatus: "waiting_confirm",
      },
      expectedLoaded: false,
    },
  ];

  for (const row of cases) {
    const fake = createFakeDb();
    fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
    fake.seedAvailabilityRequest(BUSINESS_ID, AVR_ID, {
      requestId: AVR_ID,
      itemLabel: "Untrusted fallback item",
      requestedDuration: 99,
      priceQuote: { total: 999999 },
      ...row.request,
    });
    const resolved = await resolveActiveCustomerBookingFacts({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      getBusinessProfileFn: async () => ({ businessName: "X" }),
    });
    assert.equal(resolved.ok, true, row.name);
    assert.equal(Boolean(resolved.facts.availabilityRequest), row.expectedLoaded, row.name);
    assert.equal(resolved.facts.booking.itemLabel, "Honda Civic 2026", row.name);
    assert.equal(resolved.facts.booking.durationDays, 2, row.name);
    assert.equal(resolved.facts.booking.totalAmount, 16000, row.name);
  }
});

test("missing customer identity fails before facts or OpenAI can run", async () => {
  let factHydrations = 0;
  let openaiCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: "",
    messageText: "booking status?",
    __resolveActiveCustomerBookingFactsFn: async () => {
      factHydrations += 1;
      return { ok: true, facts: baseApprovedBooking() };
    },
    __chatCompletionsCreateForTests: async () => {
      openaiCalls += 1;
      return mockOpenAiReply("must not run")();
    },
  });
  assert.deepEqual(result, { handled: false, reason: "MISSING_CONTEXT" });
  assert.equal(factHydrations, 0);
  assert.equal(openaiCalls, 0);
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
  assert.equal(amb.ok, true);
  assert.equal(amb.reason, "AMBIGUOUS_BOOKINGS");
  assert.equal(amb.facts.activeBookings.length, 2);

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
        return mockOpenAiSocialReply(mockReply)(args);
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
          return mockOpenAiReply(mockReply)(args);
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

test("post-confirm action meaning is not pre-classified before OpenAI", async () => {
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
      assert.equal(result.handled, true);
      assert.equal(result.finalReplySource, "openai_post_confirm_pa");
      assert.equal(openaiCalls, 1);
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
    assert.equal(sent, "");
    assert.equal(result.reply, "");
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
  assert.doesNotMatch(compact, /avr_pa_001|bk_pa_001|owner-business-pa-1/);

  const ai = await generateCustomerBusinessPaReplyFromFacts({
    facts: JSON.parse(compact),
    userMessage: "Rent kitna?",
    __chatCompletionsCreateForTests: mockOpenAiReply("16000 total tha."),
  });
  assert.equal(ai.ok, true);
  assert.equal(ai.reply, "16000 total tha.");
});

test("buffer: PA reply skips general Brain and uses normal Cloud outbound", async () => {
  __clearWhatsAppInboundBufferForTests?.();
  let brainV2Calls = 0;
  let processCalls = 0;
  let paCalls = 0;
  let confirmCalls = 0;
  let outcome = null;
  let lifecycleIdentity = null;

  const prevLive = process.env.EMILY_BRAIN_V2_LIVE;
  const prevBiz = process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES;
  const prevAllow = process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";

  try {
    const msg = `Advance kitna? [test:${randomUUID()}]`;
    const providerMessageId = `wamid.pa-${randomUUID()}`;
    lifecycleIdentity = buildCloudInboundLifecycleIdentity({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: providerMessageId,
    });
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
      messageId: providerMessageId,
      __resolveActiveCustomerBookingFactsFn: async () => {
        const claimedBeforeResolution = getInboundTurnLedgerEntry(
          lifecycleIdentity.chatKey,
          lifecycleIdentity.stableId,
          { force: true }
        );
        assert.equal(claimedBeforeResolution?.state, "processing");
        assert.equal(
          claimedBeforeResolution?.sourceKind,
          "cloud_dm_ownership_probe"
        );
        return {
          ok: true,
          reason: "MATCHED",
          facts: {
            booking: { id: BOOKING_ID },
            pendingAvailabilityRequests: [],
          },
        };
      },
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
          finalReplySource: "openai_post_confirm_pa",
        };
      },
      __sendOutboundMessageFn: async ({ reply, sendVia }) => {
        assert.equal(reply, "natural openai reply");
        assert.equal(sendVia, "CLOUD_API");
        return { ok: true };
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

  assert.equal(confirmCalls, 0);
  assert.equal(paCalls, 1);
  assert.equal(brainV2Calls, 0);
  assert.equal(processCalls, 0);
  assert.equal(outcome?.reply, "natural openai reply");
  assert.equal(outcome?.sendVia, "CLOUD_API");
  assert.equal(outcome?.intentionalSilent, false);
  assert.equal(
    outcome?.messageMeta?.outboundTrace?.finalReplySource,
    "openai_post_confirm_pa"
  );
  assert.equal(outcome?.messageMeta?.customerBusinessPaHandled, true);
  const completedLifecycle = getInboundTurnLedgerEntry(
    lifecycleIdentity.chatKey,
    lifecycleIdentity.stableId,
    { force: true }
  );
  assert.equal(completedLifecycle?.state, "done");
  assert.equal(completedLifecycle?.replySent, true);
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
