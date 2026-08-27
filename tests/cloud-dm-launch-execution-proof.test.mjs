import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { parseCloudDmOwnershipDecision, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK } =
  await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } = await import(
  "../src/brain/contracts/cloudCanonicalSemantic.js"
);
const { handleAvailabilityCustomerCloudInbound } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);
const { handlePaMissingInfoOwnerAnswerInbound } = await import(
  "../src/services/paMissingInfoOwnerAnswerService.js"
);
const { buildPaMissingInfoOwnerNotificationMessage } = await import(
  "../src/services/paMissingInfoOwnerNotifyService.js"
);
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);
const { AVAILABILITY_DM_PROMPT_TYPES } = await import(
  "../src/brain/availabilityConfirmation/index.js"
);

const BUSINESS_ID = "biz";
const STONIC_ID = "kia-stonic";
const CIVIC_ID = "honda-civic";
const COROLLA_ID = "toyota-corolla";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const CIVIC_IMAGE = "https://cdn.example.test/civic.jpg";

const catalog = [
  {
    id: STONIC_ID,
    name: "Kia Stonic",
    displayLabel: "Kia Stonic",
    pricing: { daily: 7000 },
  },
  {
    id: CIVIC_ID,
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    aliases: ["Civic"],
    pricing: { daily: 8000 },
    images: [CIVIC_IMAGE],
  },
  {
    id: COROLLA_ID,
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla",
    aliases: ["Corolla"],
    pricing: { daily: 6500 },
  },
];

const stonicFocus = {
  itemId: STONIC_ID,
  itemLabel: "Kia Stonic",
  provenance: "verified_assistant_presented_item",
  sourceTurnId: "assistant:stonic-turn",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function span(message, surface) {
  const start = message.indexOf(surface);
  return {
    source: "current_turn",
    surfaceText: surface,
    start,
    end: start + surface.length,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function canonicalDecision(message, overrides = {}) {
  const itemSurface = overrides.itemSurface ?? "Civic";
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      itemScope: "specific",
      itemReferents: [span(message, itemSurface)],
      targetReference: {
        source: "none",
        sourceTurnId: null,
        targetType: "none",
        targetId: null,
      },
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
      capability: null,
      evidenceNeeds: [],
      ...overrides,
    }),
    {
      customerMessage: message,
      trustedFreshItemFocus: stonicFocus,
    }
  );
  return {
    ...parsed,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function createLaunchFakeDb() {
  const store = { businesses: {} };
  const docs = new Map();
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
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
      this._write(data, opts.merge === true);
    }
    async update(data) {
      const node = this._node();
      if (!node) throw new Error(`missing doc ${this.path.join("/")}`);
      node.data = { ...node.data, ...structuredClone(data) };
      this._mirror();
    }
    _write(data, merge) {
      const [rootCollection, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (rootCollection === "businesses" && !subCollection) {
        business.data = merge
          ? { ...business.data, ...structuredClone(data) }
          : structuredClone(data);
        return;
      }
      business[subCollection] ||= {};
      business[subCollection][docId] ||= { data: {} };
      business[subCollection][docId].data = merge
        ? { ...business[subCollection][docId].data, ...structuredClone(data) }
        : structuredClone(data);
      this._mirror();
    }
    _mirror() {
      const [rootCollection, rootId, subCollection, docId] = this.path;
      if (rootCollection !== "businesses" || !subCollection || !docId) return;
      const node = store.businesses[rootId]?.[subCollection]?.[docId];
      if (!node) return;
      docs.set(`businesses/${rootId}/${subCollection}/${docId}`, {
        ...node.data,
      });
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
    docs,
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
    store,
    docs,
    ensureBusiness,
    setOwnerPhone(businessId, phone) {
      const b = ensureBusiness(businessId);
      b.data = {
        ...b.data,
        ownerNotificationPhone: phone,
        businessProfile: { ownerNotificationPhone: phone },
      };
    },
    listAvrs(businessId) {
      return Object.entries(
        ensureBusiness(businessId).availabilityRequests || {}
      ).map(([id, node]) => ({ id, ...(node.data || {}) }));
    },
    listBookings(businessId) {
      return Object.entries(ensureBusiness(businessId).bookings || {}).map(
        ([id, node]) => ({ id, ...(node.data || {}) })
      );
    },
    listMissingInfo(businessId) {
      return Object.entries(
        ensureBusiness(businessId).paMissingInfoRequests || {}
      ).map(([id, node]) => ({ id, ...(node.data || {}) }));
    },
    seedAvailabilityRequest(businessId, requestId, data) {
      ensureBusiness(businessId).availabilityRequests[requestId] = {
        data: { ...data },
      };
      docs.set(
        `businesses/${businessId}/availabilityRequests/${requestId}`,
        { ...data }
      );
    },
  };
}

function composeJson(reply, claims = []) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims,
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

function withAvrExecuteFlags(fn) {
  const prevCheck = process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE;
  const prevNotify = process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE;
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = "true";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE = "true";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevCheck === undefined) {
        delete process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE;
      } else {
        process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = prevCheck;
      }
      if (prevNotify === undefined) {
        delete process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE;
      } else {
        process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE = prevNotify;
      }
    });
}

async function runCloud(p) {
  return runBrainV2LivePipeline({
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    memorySnapshot: { lastFreshItemFocus: stonicFocus, lastResolvedItemId: STONIC_ID },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    ...p,
  });
}

test("missing-business-fact request is created, owner notified, and owner reply returns to the same customer", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const ownerSends = [];
  const customerSends = [];
  const message = "Does Civic have a child seat?";
  const live = await runCloud({
    traceId: "missing-fact-create",
    message,
    messageId: "wamid.child-seat-1",
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "details_inquiry",
    }),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async (to, text) => {
        ownerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.owner-notify-1" };
      },
    },
  });
  assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
  assert.doesNotMatch(String(live.reply), /\bowner\b|\bstaff\b|\bPA\b/i);
  const rows = fake.listMissingInfo(BUSINESS_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, CIVIC_ID);
  assert.equal(rows[0].bookingId, null);
  assert.equal(rows[0].scopeKind, "catalog_item");
  assert.equal(rows[0].customerPhone, CUSTOMER_PHONE);
  assert.equal(rows[0].customerMessageId, "wamid.child-seat-1");
  assert.equal(rows[0].sourceTurnId, "wamid.child-seat-1");
  assert.match(String(rows[0].itemLabel), /Civic/i);
  assert.doesNotMatch(String(rows[0].itemLabel), /Stonic/i);
  assert.equal(ownerSends.length, 1);
  assert.match(String(ownerSends[0].text), /Civic/i);
  assert.doesNotMatch(String(ownerSends[0].text), /Stonic/i);
  const rebuilt = buildPaMissingInfoOwnerNotificationMessage(rows[0]);
  assert.match(rebuilt, /Civic/i);

  const replay = await runCloud({
    traceId: "missing-fact-dedupe",
    message,
    messageId: "wamid.child-seat-1",
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "details_inquiry",
    }),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not re-notify");
      },
    },
  });
  assert.equal(replay.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);

  const followup = await handlePaMissingInfoOwnerAnswerInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: "Haan, Civic mein child seat available hai.",
    messageId: "wamid.owner-answer-1",
    contextMessageId: "wamid.owner-notify-1",
    missingInfoEnabled: false,
    ownerAnswerEnabled: false,
    sendWhatsAppMessageFn: async (to, text) => {
      customerSends.push({ to, text });
      return { ok: true, providerMessageId: "wamid.customer-1" };
    },
    __classifyOwnerResponseKindFn: async () => ({
      ok: true,
      kind: "final_answer",
      source: "test",
    }),
    __generateFollowupFn: async () => ({
      ok: true,
      reply: "Haan, Civic mein child seat available hai.",
      source: "openai",
    }),
  });
  assert.equal(followup.handled, true);
  assert.equal(followup.customerFollowupSent, true);
  assert.equal(customerSends.length, 1);
  assert.equal(String(customerSends[0].to).replace(/\D/g, ""), CUSTOMER_PHONE);
  assert.match(String(customerSends[0].text), /Civic|child seat/i);
  assert.doesNotMatch(String(customerSends[0].text), /\bowner\b/i);
});

test("Case A: Stonic focus + Civic available creates Civic AVR only", async () => {
  await withAvrExecuteFlags(async () => {
  const fake = createLaunchFakeDb();
  const ownerSends = [];
  const message = "Civic 3 din ke liye available hai?";
  const live = await runCloud({
    traceId: "case-a-civic-avr",
    message,
    messageId: "wamid.civic-avail-1",
    sessionKey: "case-a",
    participantKey: "cust-1",
    chatId: "dm-1",
    canonicalSemanticDecision: canonicalDecision(message),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async (to, text) => {
        ownerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.avr-owner-1" };
      },
    },
  });
  const avrs = fake.listAvrs(BUSINESS_ID);
  const created = live.messageMeta?.actionRouter?.sideEffectResults
    ?.AVAILABILITY_OWNER_CHECK_REQUIRED;
  assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
  assert.ok(created?.ok === true);
  assert.equal(created.created, true);
  assert.equal(created.request?.itemId || created.itemId, CIVIC_ID);
  assert.equal(avrs.length, 1);
  assert.equal(avrs[0].itemId, CIVIC_ID);
  assert.match(String(avrs[0].itemLabel), /Civic/i);
  assert.ok(!avrs.some((row) => row.itemId === STONIC_ID));
  const plannedIds = (live.messageMeta?.actionPlan?.actions ?? [])
    .map((action) => String(action?.payload?.itemId ?? "").trim())
    .filter(Boolean);
  assert.ok(plannedIds.includes(CIVIC_ID));
  assert.ok(!plannedIds.includes(STONIC_ID));
  assert.equal(ownerSends.length, 1);
  assert.match(String(ownerSends[0].text), /Civic/i);
  assert.doesNotMatch(String(ownerSends[0].text), /Stonic/i);
  });
});

test("Case A companion: Civic available without duration still targets Civic and creates no Stonic AVR", async () => {
  const fake = createLaunchFakeDb();
  const message = "Civic available hai?";
  const live = await runCloud({
    traceId: "case-a-duration-ask",
    message,
    messageId: "wamid.civic-avail-no-duration",
    canonicalSemanticDecision: canonicalDecision(message),
    executionContext: { db: fake.db, ownerNotificationPhone: OWNER_PHONE },
  });
  assert.equal(live.messageMeta?.outboundTrace?.authoritativeItemId, CIVIC_ID);
  assert.equal(fake.listAvrs(BUSINESS_ID).length, 0);
  const plannedIds = (live.messageMeta?.actionPlan?.actions ?? [])
    .map((action) => String(action?.payload?.itemId ?? "").trim())
    .filter(Boolean);
  assert.ok(!plannedIds.includes(STONIC_ID));
  assert.notEqual(String(live.reply ?? "").trim(), "");
});

test("Case B: approved Civic AVR + book kar do creates one Civic booking and is replay-safe", async () => {
  const fake = createLaunchFakeDb();
  const requestId = "avr_civic_case_b";
  fake.seedAvailabilityRequest(BUSINESS_ID, requestId, {
    requestId,
    businessId: BUSINESS_ID,
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic",
    status: "approved",
    requestedDuration: 3,
    customerDmTarget: CUSTOMER_PHONE,
    customerPhone: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: new Date(),
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    confirmExpiresAt: buildConfirmExpiresAt(new Date()),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerNotifyMessage: "Honda Civic 3 din ke liye available hai. Book kar du?",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR", durationDays: 3 },
  });
  const frozen = {
    turnScope: "PENDING_AVAILABILITY_REFERENCE",
    semanticIntent: "booking_request",
    action: "confirm_pending_availability",
    targetId: requestId,
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:wamid.book-1",
      targetType: "availability_request",
      targetId: requestId,
    },
    semanticDecisionStatus: "released",
  };
  const first = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "book kar do",
    messageId: "wamid.book-1",
    availabilityConfirmExecute: true,
    canonicalSemanticDecision: frozen,
    sendWhatsAppMessageFn: async () => ({ ok: true, providerMessageId: "wamid.cust-book" }),
    __composeWaitingConfirmExecutionReplyForTests: async () => ({
      ok: true,
      reply: "Civic book ho gayi.",
      source: "test",
    }),
  });
  assert.equal(first.handled, true);
  assert.equal(first.action, "confirmed_booking");
  const bookings = fake.listBookings(BUSINESS_ID);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].itemId, CIVIC_ID);
  assert.equal(
    bookings[0].availabilityRequestId || bookings[0].sourceAvailabilityRequestId,
    requestId
  );
  const replay = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "book kar do",
    messageId: "wamid.book-1",
    availabilityConfirmExecute: true,
    canonicalSemanticDecision: frozen,
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __composeWaitingConfirmExecutionReplyForTests: async () => ({
      ok: true,
      reply: "Civic book ho gayi.",
      source: "test",
    }),
  });
  assert.equal(replay.handled, true);
  assert.equal(replay.duplicate, true);
  assert.equal(fake.listBookings(BUSINESS_ID).length, 1);
});

test("Case C: approved Civic request then Corolla switch cannot book the old Civic AVR", async () => {
  const fake = createLaunchFakeDb();
  const civicAvrId = "avr_civic_case_c";
  fake.seedAvailabilityRequest(BUSINESS_ID, civicAvrId, {
    requestId: civicAvrId,
    businessId: BUSINESS_ID,
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic",
    status: "approved",
    requestedDuration: 3,
    customerDmTarget: CUSTOMER_PHONE,
    customerPhone: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: new Date(),
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    confirmExpiresAt: buildConfirmExpiresAt(new Date()),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    priceQuote: { status: "quoted", total: 24000, currency: "PKR", durationDays: 3 },
  });
  const corollaMessage = "Corolla 3 din ke liye chahiye";
  const frozen = canonicalDecision(corollaMessage, {
    itemSurface: "Corolla",
    semanticIntent: "availability_inquiry",
  });
  const waiting = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: corollaMessage,
    messageId: "wamid.corolla-1",
    availabilityConfirmExecute: true,
    canonicalSemanticDecision: frozen,
    sendWhatsAppMessageFn: async () => {
      throw new Error("should not confirm old Civic");
    },
  });
  assert.equal(waiting.handled, false);
  assert.equal(waiting.reason, "CANONICAL_SCOPE_NOT_PENDING");
  assert.equal(fake.listBookings(BUSINESS_ID).length, 0);

  await withAvrExecuteFlags(async () => {
  const live = await runCloud({
    traceId: "case-c-corolla",
    message: corollaMessage,
    messageId: "wamid.corolla-1",
    sessionKey: "case-c",
    participantKey: "cust-1",
    chatId: "dm-1",
    canonicalSemanticDecision: frozen,
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => ({ ok: true, providerMessageId: "wamid.corolla-owner" }),
    },
  });
  const avrs = fake.listAvrs(BUSINESS_ID);
  const newAvrs = avrs.filter((row) => row.itemId === COROLLA_ID);
  assert.ok(newAvrs.length >= 1);
  assert.ok(!avrs.some((row) => row.status === "completed" && row.itemId === CIVIC_ID));
  assert.equal(fake.listBookings(BUSINESS_ID).length, 0);
  const civicStillWaiting = avrs.find((row) => row.requestId === civicAvrId || row.id === civicAvrId);
  assert.equal(civicStillWaiting?.customerConfirmationStatus, "waiting_confirm");
  const plannedIds = (live.messageMeta?.actionPlan?.actions ?? [])
    .map((action) => String(action?.payload?.itemId ?? "").trim())
    .filter(Boolean);
  assert.ok(plannedIds.includes(COROLLA_ID));
  assert.ok(!plannedIds.includes(CIVIC_ID));
  });
});

test("image catalog request sends trusted Civic URLs instead of clarification", async () => {
  const message = "Civic ki pictures bhej dein";
  const live = await runCloud({
    traceId: "civic-images",
    message,
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "image_catalog_request",
    }),
  });
  assert.equal(live.workflowType, "image_catalog_request");
  assert.notEqual(live.customerTurnOutcome, "CUSTOMER_CLARIFICATION");
  assert.deepEqual(live.messageMeta?.whatsappImageUrls, [CIVIC_IMAGE]);
  assert.equal(live.messageMeta?.deliveryIntent, "show_images");
  assert.doesNotMatch(String(live.reply), /samajh nahi/i);
});

test("image request without trusted URLs becomes TECHNICAL_RECOVERY, not fabricated URLs or an owner-check promise", async () => {
  const message = "Stonic ki pictures bhej dein";
  const live = await runCloud({
    traceId: "stonic-images-missing",
    message,
    catalogItems: catalog.map((row) =>
      row.id === STONIC_ID ? { ...row, images: [] } : row
    ),
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "image_catalog_request",
      itemSurface: "Stonic",
    }),
  });
  assert.equal(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(live.messageMeta?.whatsappImageUrls, undefined);
});

test("Cloud launch pricing reply uses OpenAI compose when injected", async () => {
  const message = "Civic ka rent?";
  const live = await runCloud({
    traceId: "compose-pricing",
    message,
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "pricing_inquiry",
    }),
    __cloudComposeChatCreate: async () =>
      composeJson("Civic ka rent 8,000 PKR per day hai.", ["quotation_verified"]),
  });
  assert.equal(live.reply, "Civic ka rent 8,000 PKR per day hai.");
  assert.equal(live.messageMeta?.outboundTrace?.finalReplySource, "CLOUD_CANONICAL_OPENAI_COMPOSE");
  assert.equal(live.customerTurnOutcome, "ANSWER");
});

async function runMissingFact(overrides = {}) {
  const message = overrides.message ?? "Does Civic have a child seat?";
  const { message: _ignored, ...rest } = overrides;
  return runCloud({
    message,
    canonicalSemanticDecision: canonicalDecision(message, {
      semanticIntent: "details_inquiry",
    }),
    ...rest,
  });
}

test("OWNER_CHECK holding allowed after create success + notify success", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const live = await runMissingFact({
    traceId: "holding-create-notify-ok",
    messageId: "wamid.holding-ok",
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.holding-owner-1",
      }),
    },
  });
  assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  assert.equal(fake.listMissingInfo(BUSINESS_ID)[0].ownerNotifyStatus, "sent");
});

test("OWNER_CHECK holding allowed when already-notified request is reused without duplicate notify", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  let notifyCalls = 0;
  const executionContext = {
    db: fake.db,
    ownerNotificationPhone: OWNER_PHONE,
    sendWhatsAppMessageFn: async () => {
      notifyCalls += 1;
      return { ok: true, providerMessageId: "wamid.holding-reuse-1" };
    },
  };
  const first = await runMissingFact({
    traceId: "holding-reuse-1",
    messageId: "wamid.holding-reuse",
    executionContext,
  });
  const second = await runMissingFact({
    traceId: "holding-reuse-2",
    messageId: "wamid.holding-reuse",
    executionContext,
  });
  assert.equal(first.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(second.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(second.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(notifyCalls, 1);
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
});

test("create failure does not send OWNER_CHECK holding promise", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const live = await runMissingFact({
    traceId: "holding-create-fail",
    messageId: "wamid.holding-create-fail",
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => {
        throw new Error("should not notify after create failure");
      },
    },
    __createOrGetOpenPaMissingInfoRequestFn: async () => ({
      ok: false,
      reason: "CREATE_FAILED",
      created: false,
      request: null,
    }),
  });
  assert.equal(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(live.reason, "CREATE_FAILED");
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
});

test("notify failure does not send OWNER_CHECK holding promise", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const live = await runMissingFact({
    traceId: "holding-notify-fail",
    messageId: "wamid.holding-notify-fail",
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
    },
    __sendPaMissingInfoOwnerNotificationFn: async () => ({
      ok: false,
      sent: false,
      ownerNotifyStatus: "failed",
      reason: "NOTIFY_FAILED",
    }),
  });
  assert.equal(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(live.reason, "NOTIFY_FAILED");
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
});

test("DB unavailable does not send OWNER_CHECK holding promise", async () => {
  const live = await runMissingFact({
    traceId: "holding-db-unavailable",
    messageId: "wamid.holding-no-db",
  });
  assert.equal(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(live.reason, "DB_UNAVAILABLE");
});

test("notify fails then later retry succeeds before OWNER_CHECK holding is allowed", async () => {
  const fake = createLaunchFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  let notifyCalls = 0;
  const notifyFn = async () => {
    notifyCalls += 1;
    if (notifyCalls === 1) {
      return {
        ok: false,
        sent: false,
        ownerNotifyStatus: "failed",
        reason: "NOTIFY_FAILED",
      };
    }
    return {
      ok: true,
      sent: true,
      skipped: false,
      ownerNotifyStatus: "sent",
      reason: "SENT",
    };
  };
  const first = await runMissingFact({
    traceId: "holding-retry-1",
    messageId: "wamid.holding-retry",
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
    },
    __sendPaMissingInfoOwnerNotificationFn: notifyFn,
  });
  assert.equal(first.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(first.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);

  const second = await runMissingFact({
    traceId: "holding-retry-2",
    messageId: "wamid.holding-retry",
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
    },
    __sendPaMissingInfoOwnerNotificationFn: notifyFn,
  });
  assert.equal(second.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(second.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.equal(notifyCalls, 2);
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
});
