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
  PA_MISSING_INFO_OWNER_AMBIGUOUS_NUDGE,
} = await import("../src/services/paMissingInfoOwnerAnswerService.js");
const {
  getPaMissingInfoRequest,
  isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback,
  listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests,
} = await import("../src/services/paMissingInfoRequestService.js");

const BUSINESS_ID = "owner-pa-ans-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const OTHER_PHONE = "923007776655";
const BOOKING_ID = "bk_pa_ans_001";
const AVR_ID = "avr_pa_ans_001";
const REQUEST_ID = "pamiss_abcdef0123456789ab";
const NOTIFY_WAMID = "wamid.pa-notify-1";
const OTHER_NOTIFY_WAMID = "wamid.pa-notify-2";
const OTHER_CUSTOMER = "923004445556";

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
    ownerNotifyProviderMessageId: NOTIFY_WAMID,
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

test("multiline owner notification has no visible pamiss token", async () => {
  const { buildPaMissingInfoOwnerNotificationMessage } = await import(
    "../src/services/paMissingInfoOwnerNotifyService.js"
  );
  const notify = buildPaMissingInfoOwnerNotificationMessage({
    requestId: REQUEST_ID,
    bookingId: BOOKING_ID,
    customerPhone: OWNER_PHONE,
    missingInfoType: "other",
    customerQuestion: "Refund policy kya hai?",
    itemLabel: "Toyota corolla (Metallic Grey)",
  });
  assert.doesNotMatch(notify, /Reference:/i);
  assert.doesNotMatch(notify, /pamiss_/i);
  assert.ok(!notify.includes(REQUEST_ID));
  assert.doesNotMatch(notify, new RegExp(BOOKING_ID));
  assert.doesNotMatch(notify, /\bother\b|\bdocuments\b/i);
  assert.match(notify, /Reply to this message with the answer/);

  // Parser may still strip a pasted token for answer text cleanliness.
  const parsed = parsePaMissingInfoOwnerAnswerMessage(
    `Fuel customer ke zimme.\n${REQUEST_ID}`
  );
  assert.equal(parsed.requestId, REQUEST_ID);
  assert.match(parsed.ownerAnswer, /Fuel customer/i);
});

test("quoted tokenless owner reply routes by context.id and sends customer follow-up", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const customerSends = [];
  const memory = [];
  let openaiCalls = 0;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance half amount before pickup",
      messageId: "wamid.owner-1",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-out-1" };
      },
      __appendConversationMessageFn: async (_db, p) => {
        memory.push(p);
      },
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        return followupOpenAiResponse(
          "Advance half amount before pickup dena hoga."
        );
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.customerFollowupSent, true);
    assert.equal(result.requestId, REQUEST_ID);
    assert.equal(result.matchReason, "CONTEXT_ID");
    assert.equal(result.openaiUsed, true);
    assert.equal(openaiCalls, 1);
    assert.equal(customerSends.length, 1);
    assert.equal(phoneDigits(customerSends[0].to), CUSTOMER_PHONE);
    assert.equal(
      customerSends[0].text,
      "Advance half amount before pickup dena hoga."
    );
    assert.equal(memory.length, 1);
    assert.equal(memory[0].role, "assistant");
    assert.equal(
      memory[0].text,
      "Advance half amount before pickup dena hoga."
    );
    assert.equal(memory[0].ownerUserId, BUSINESS_ID);
    assert.equal(phoneDigits(memory[0].customerNumber), CUSTOMER_PHONE);

    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "closed");
    assert.equal(row.ownerAnswer, "Advance half amount before pickup");
    assert.equal(row.ownerAnswerMessageId, "wamid.owner-1");
    assert.equal(
      row.customerFollowupText,
      "Advance half amount before pickup dena hoga."
    );
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

test("duplicate same owner message does not send twice", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  let sendCount = 0;
  const common = {
    __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: "half amount before pickup",
    messageId: "wamid.owner-dup",
    contextMessageId: NOTIFY_WAMID,
    sendWhatsAppMessageFn: async () => {
      sendCount += 1;
      return { ok: true, providerMessageId: "wamid.x" };
    },
    __chatCompletionsCreateForTests: async () =>
      followupOpenAiResponse("Advance half amount before pickup dena hoga."),
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
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "7000",
      messageId: "wamid.owner-after-close",
      contextMessageId: NOTIFY_WAMID,
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

test("customer follow-up send failure does not close request or report success", async () => {
  const fake = createFakeDb();
  seedContext(fake);

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "half amount before pickup",
      messageId: "wamid.owner-send-fail",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("WHATSAPP_API_FAILED");
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse(
          "Advance half amount before pickup dena hoga."
        ),
    });

    assert.equal(result.handled, true);
    assert.equal(result.customerFollowupSent, false);
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_FAILED");
    assert.equal(result.action, "owner_answer_followup_failed");
    assert.equal(result.status, "customer_followup_failed");
    assert.notEqual(result.status, "closed");

    const row = fake.getMissingInfo(BUSINESS_ID, REQUEST_ID);
    assert.equal(row.status, "customer_followup_failed");
    assert.notEqual(row.status, "closed");
    assert.equal(row.customerFollowupStatus, "failed");
    assert.equal(row.customerFollowupStatus !== "sent", true);
    assert.equal(row.closedAt ?? null, null);
  });
});

test("no quote + exactly one eligible owner_notified request binds (tokenless fallback)", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const customerSends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({
        ok: true,
        kind: "final_answer",
        source: "test",
      }),
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance 50 percent hai",
      messageId: "wamid.owner-no-quote",
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-out-tokenless" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Advance 50 percent before pickup."),
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "CUSTOMER_FOLLOWUP_SENT");
    assert.equal(result.matchReason, "SINGLE_OWNER_NOTIFIED");
    assert.equal(result.customerFollowupSent, true);
    assert.equal(customerSends.length, 1);
    assert.equal(phoneDigits(customerSends[0].to), CUSTOMER_PHONE);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "closed"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer,
      "Advance 50 percent hai"
    );
  });
});

test("no quote + two eligible owner_notified requests → ambiguous nudge, rows unchanged", async () => {
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
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: OTHER_NOTIFY_WAMID,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  const sends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({
        ok: true,
        kind: "final_answer",
        source: "test",
      }),
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Driver available hai",
      messageId: "wamid.owner-multi",
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "AMBIGUOUS_ELIGIBLE_REQUESTS");
    assert.equal(result.eligibleCount, 2);
    assert.equal(result.customerFollowupSent, false);
    assert.equal(sends.length, 1);
    assert.equal(phoneDigits(sends[0].to), OWNER_PHONE);
    assert.equal(sends[0].text, PA_MISSING_INFO_OWNER_AMBIGUOUS_NUDGE);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, "pamiss_bbbbbbbbbbbbbbbbbb").status,
      "owner_notified"
    );
  });
});

test("no quote + zero eligible requests is not consumed as pamiss answer", async () => {
  const fake = createFakeDb();
  seedContext(fake, {
    requestOverrides: {
      status: "open",
      ownerNotifyStatus: "not_started",
      ownerNotifyProviderMessageId: null,
    },
  });

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance 50 percent hai",
      messageId: "wamid.owner-zero",
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "NO_ELIGIBLE_OWNER_NOTIFIED_REQUEST");
    const viaTry = await tryHandlePaMissingInfoOwnerAnswer({
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance 50 percent hai",
      messageId: "wamid.owner-zero-try",
    });
    assert.equal(viaTry, null);
  });
});

test("tokenless eligibility permits sent/queued and excludes all other request states", async () => {
  const now = new Date();
  const expired = new Date(now.getTime() - 60_000);
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
      expiresAt: new Date(now.getTime() + 60_000),
    }),
    true
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "awaiting_customer_clarification",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
    }),
    false
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "open",
      ownerNotifyStatus: "not_started",
      ownerNotifyProviderMessageId: null,
    }),
    false
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "owner_notified",
      ownerNotifyStatus: "queued",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
      expiresAt: new Date(now.getTime() + 60_000),
    }),
    true
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "owner_notified",
      ownerNotifyStatus: "sending",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
    }),
    false
  );
  for (const status of [
    "open",
    "awaiting_customer_clarification",
    "failed",
    "answered",
    "customer_notified",
    "customer_followup_failed",
    "closed",
  ]) {
    assert.equal(
      isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
        status,
        ownerNotifyStatus: "sent",
        ownerNotifyProviderMessageId: NOTIFY_WAMID,
      }),
      false,
      status
    );
  }
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "owner_notified",
      ownerNotifyStatus: "failed",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
    }),
    false
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "closed",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
    }),
    false
  );
  assert.equal(
    isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback({
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: NOTIFY_WAMID,
      expiresAt: expired,
    }),
    false
  );

  const fake = createFakeDb();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  fake.seedMissingInfo(BUSINESS_ID, REQUEST_ID, baseRequest());
  fake.seedMissingInfo(BUSINESS_ID, "pamiss_open_only", {
    ...baseRequest({ requestId: "pamiss_open_only" }),
    status: "open",
    ownerNotifyStatus: "not_started",
    ownerNotifyProviderMessageId: null,
  });
  fake.seedMissingInfo(BUSINESS_ID, "pamiss_awaiting", {
    ...baseRequest({ requestId: "pamiss_awaiting" }),
    status: "awaiting_customer_clarification",
    ownerNotifyStatus: "sent",
    ownerNotifyProviderMessageId: "wamid.awaiting",
  });
  fake.seedMissingInfo(BUSINESS_ID, "pamiss_expired", {
    ...baseRequest({ requestId: "pamiss_expired" }),
    expiresAt: expired,
  });

  const eligible =
    await listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests({
      db: fake.db,
      businessId: BUSINESS_ID,
    });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].requestId, REQUEST_ID);
});

test("context.id wins with multiple eligible owner_notified requests open", async () => {
  const fake = createFakeDb();
  const now = new Date();
  const otherRequestId = "pamiss_ccccccccccccccc";
  seedContext(fake, {
    secondRequest: {
      requestId: otherRequestId,
      businessId: BUSINESS_ID,
      customerPhone: OTHER_CUSTOMER,
      bookingId: BOOKING_ID,
      missingInfoType: "other",
      customerQuestion: "Fuel average?",
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: OTHER_NOTIFY_WAMID,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  const customerSends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({
        ok: true,
        kind: "final_answer",
        source: "test",
      }),
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "45 km/ltr",
      messageId: "wamid.owner-fuel-ctx",
      contextMessageId: OTHER_NOTIFY_WAMID,
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.out-fuel-ctx" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Gari ki average 45 km/ltr hai."),
    });

    assert.equal(result.matchReason, "CONTEXT_ID");
    assert.equal(result.requestId, otherRequestId);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
    assert.equal(fake.getMissingInfo(BUSINESS_ID, otherRequestId).status, "closed");
  });
});

test("punctuation-only owner answer ??? rejected; request stays open", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  let sendCount = 0;

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "???",
      messageId: "wamid.owner-junk",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => {
        sendCount += 1;
        return { ok: true };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "UNUSABLE_OWNER_ANSWER");
    assert.equal(result.action, "owner_answer_rejected");
    assert.equal(result.customerFollowupSent, false);
    assert.equal(sendCount, 0);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer ?? null,
      null
    );
  });
});

test("unknown context.id rejects safely and does not modify request", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const sends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Full refund",
      messageId: "wamid.owner-unknown-ctx",
      contextMessageId: "wamid.does-not-exist",
      sendWhatsAppMessageFn: async (to, text) => {
        sends.push({ to, text });
        return { ok: true };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.reason, "CONTEXT_UNKNOWN");
    assert.equal(result.customerFollowupSent, false);
    assert.equal(sends.length, 1);
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer ?? null,
      null
    );
  });
});

test("two simultaneous requests stay independent via context.id", async () => {
  const fake = createFakeDb();
  const now = new Date();
  const otherRequestId = "pamiss_ccccccccccccccc";
  seedContext(fake, {
    secondRequest: {
      requestId: otherRequestId,
      businessId: BUSINESS_ID,
      customerPhone: OTHER_CUSTOMER,
      bookingId: BOOKING_ID,
      missingInfoType: "other",
      customerQuestion: "Fuel average?",
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyProviderMessageId: OTHER_NOTIFY_WAMID,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  const customerSends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "45 km/ltr",
      messageId: "wamid.owner-fuel",
      contextMessageId: OTHER_NOTIFY_WAMID,
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.out-fuel" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Gari ki average 45 km/ltr hai."),
    });

    assert.equal(result.customerFollowupSent, true);
    assert.equal(result.requestId, otherRequestId);
    assert.equal(customerSends.length, 1);
    assert.equal(phoneDigits(customerSends[0].to), OTHER_CUSTOMER);
    assert.notEqual(phoneDigits(customerSends[0].to), CUSTOMER_PHONE);

    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, otherRequestId).status,
      "closed"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).status,
      "owner_notified"
    );
    assert.equal(
      fake.getMissingInfo(BUSINESS_ID, REQUEST_ID).ownerAnswer ?? null,
      null
    );
  });
});

test("wrong customer never receives answer for another request", async () => {
  const fake = createFakeDb();
  seedContext(fake);
  const customerSends = [];

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance half hai",
      messageId: "wamid.owner-right-cust",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async (to, text) => {
        customerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.out-1" };
      },
      __chatCompletionsCreateForTests: async () =>
        followupOpenAiResponse("Advance half amount dena hoga."),
    });
    assert.equal(result.customerFollowupSent, true);
    assert.equal(customerSends.length, 1);
    assert.equal(phoneDigits(customerSends[0].to), CUSTOMER_PHONE);
    assert.notEqual(phoneDigits(customerSends[0].to), OTHER_CUSTOMER);
  });
});

test("notify providerMessageId is persisted from sendWhatsAppMessage result", async () => {
  const { sendPaMissingInfoOwnerNotification } = await import(
    "../src/services/paMissingInfoOwnerNotifyService.js"
  );
  const { createOrGetOpenPaMissingInfoRequest, getPaMissingInfoRequest } =
    await import("../src/services/paMissingInfoRequestService.js");
  const fake = createFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseBooking());

  const created = await createOrGetOpenPaMissingInfoRequest({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    bookingId: BOOKING_ID,
    availabilityRequestId: AVR_ID,
    missingInfoType: "advance",
    customerQuestion: "Advance kitna?",
    customerMessageId: "wamid.cust-q",
  });
  assert.equal(created.ok, true);

  const notify = await sendPaMissingInfoOwnerNotification({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: created.request,
    itemLabel: "Honda Civic",
    sendWhatsAppMessageFn: async () => ({
      ok: true,
      providerMessageId: "wamid.from-cloud-api",
    }),
  });
  assert.equal(notify.ok, true);
  assert.equal(notify.providerMessageId, "wamid.from-cloud-api");

  const row = await getPaMissingInfoRequest({
    db: fake.db,
    businessId: BUSINESS_ID,
    requestId: created.request.requestId,
  });
  assert.equal(row.ownerNotifyProviderMessageId, "wamid.from-cloud-api");
  assert.equal(row.ownerNotifyStatus, "sent");
});

test("non-owner customer DM does not trigger owner-answer handler", async () => {
  const fake = createFakeDb();
  seedContext(fake);

  await withFlags({ missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OTHER_PHONE,
      messageText: "5000",
      messageId: "wamid.cust",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "NOT_OWNER");

    const tryResult = await tryHandlePaMissingInfoOwnerAnswer({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OTHER_PHONE,
      messageText: "5000",
      contextMessageId: NOTIFY_WAMID,
    });
    assert.equal(tryResult, null);
  });
});

test("flag OFF means no owner-answer handling", async () => {
  const fake = createFakeDb();
  seedContext(fake);

  await withFlags({ missingInfo: true, ownerAnswer: false }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "5000",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, "FLAG_OFF");
  });

  await withFlags({ missingInfo: false, ownerAnswer: true }, async () => {
    const result = await handlePaMissingInfoOwnerAnswerInbound({
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "5000",
      contextMessageId: NOTIFY_WAMID,
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
      __classifyOwnerResponseKindFn: async () => ({ ok: true, kind: "final_answer", source: "test" }),

      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "half amount before pickup",
      messageId: "wamid.openai",
      contextMessageId: NOTIFY_WAMID,
      sendWhatsAppMessageFn: async () => ({ ok: true, providerMessageId: "o" }),
      __chatCompletionsCreateForTests: async (args) => {
        const blob = JSON.stringify(args);
        sawOwnerAnswerInPrompt = /OWNER_ANSWER_FOR_THIS_REQUEST/.test(blob);
        assert.doesNotMatch(blob, /HOLD_REPLIES/);
        return followupOpenAiResponse(
          "Advance half amount before pickup confirm hai."
        );
      },
    });
    assert.equal(result.openaiUsed, true);
    assert.equal(sawOwnerAnswerInPrompt, true);
    assert.equal(
      result.customerFollowupText,
      "Advance half amount before pickup confirm hai."
    );
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
