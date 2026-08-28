import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const ROOT = dirname(fileURLToPath(import.meta.url));

const {
  parseCloudDmOwnershipDecision,
  executeCloudDmOwnershipDecision,
  canEscalatePostConfirmMissingInfo,
  PA_MISSING_INFO_GATE_OUTCOME,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { composePostConfirmInformationalCustomerReply } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);
const { isTrustedVerifiedFactResolution } = await import(
  "../src/brain/facts/resolvePostConfirmRequestedFact.js"
);
const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { handlePaMissingInfoOwnerAnswerInbound } = await import(
  "../src/services/paMissingInfoOwnerAnswerService.js"
);

const BUSINESS_ID = "biz";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const CIVIC_ID = "honda-civic";
const BOOKING_ID = "bk_civic_hist";
const catalog = [
  {
    id: CIVIC_ID,
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    aliases: ["Civic"],
    pricing: { daily: 8000 },
  },
];

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

function noneTarget() {
  return {
    source: "none",
    sourceTurnId: null,
    targetType: "none",
    targetId: null,
  };
}

function civicDetailsDecision(message) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "details_inquiry",
    itemScope: "specific",
    itemReferents: [span(message, "Civic")],
    targetReference: noneTarget(),
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "freeform_business",
    capability: null,
    evidenceNeeds: [],
  };
}

function staleOldBookingChildSeat(message) {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: "details_inquiry",
    itemScope: "none",
    itemReferents: [],
    itemReferenceMode: "NONE",
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:wamid.child-seat",
      targetType: "historical_booking",
      targetId: BOOKING_ID,
    },
    targetId: BOOKING_ID,
    mutationIntent: "none",
    action: "reply",
    factKind: "freeform_business",
    capability: null,
    evidenceNeeds: [],
  };
}

function genuineOldBookingStatus() {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: "details_inquiry",
    itemScope: "none",
    itemReferents: [],
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:wamid.status",
      targetType: "historical_booking",
      targetId: BOOKING_ID,
    },
    targetId: BOOKING_ID,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      { entity: "active_booking", concept: "status", attributes: ["value"] },
    ],
  };
}

function genuineOldBookingCivicPickup(message) {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: "details_inquiry",
    itemScope: "none",
    itemReferents: [],
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:wamid.pickup",
      targetType: "historical_booking",
      targetId: BOOKING_ID,
    },
    targetId: BOOKING_ID,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      { entity: "active_booking", concept: "pickup", attributes: ["location"] },
    ],
  };
}

function composeJson(reply, extra = {}) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            coveredEvidenceKeys: extra.coveredEvidenceKeys ?? ["none"],
            customerInputRequested: false,
            requestedCustomerAction: "none",
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

function createFakeDb() {
  const store = { businesses: {} };
  const docs = new Map();
  let autoId = 0;
  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      paMissingInfoRequests: {},
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
      this._write(data, opts.merge === true);
    }
    async update(data) {
      const node = this._node();
      if (!node) throw new Error(`missing ${this.path.join("/")}`);
      node.data = { ...node.data, ...structuredClone(data) };
      this._mirror();
    }
    _write(data, merge) {
      const [, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (!subCollection) {
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
      const [, rootId, subCollection, docId] = this.path;
      if (!subCollection || !docId) return;
      const node = store.businesses[rootId]?.[subCollection]?.[docId];
      if (!node) return;
      docs.set(`businesses/${rootId}/${subCollection}/${docId}`, {
        ...node.data,
      });
    }
    _node() {
      const [, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (!subCollection) return { data: business.data };
      return business[subCollection]?.[docId] ?? null;
    }
  }
  class CollectionRef {
    constructor(path, conditions = [], resultLimit = null) {
      this.path = path;
      this.conditions = conditions;
      this.resultLimit = resultLimit;
    }
    doc(id = null) {
      return new DocRef([...this.path, id == null ? `auto-${++autoId}` : String(id)]);
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
      const [, rootId, subCollection] = this.path;
      const business = ensureBusiness(rootId);
      let entries = Object.entries(business[subCollection] || {});
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
  }
  return {
    db: {
      docs,
      collection(name) {
        return new CollectionRef([name]);
      },
      async runTransaction(fn) {
        return fn({
          get: (refOrQuery) => refOrQuery.get(),
          set: (ref, data) => ref.set(data, { merge: true }),
          create: (ref, data) => ref.set(data, { merge: true }),
        });
      },
    },
    setOwnerPhone(businessId, phone) {
      const b = ensureBusiness(businessId);
      b.data = { ...b.data, ownerNotificationPhone: phone };
    },
    listMissingInfo(businessId) {
      return Object.entries(
        ensureBusiness(businessId).paMissingInfoRequests || {}
      ).map(([id, node]) => ({ id, ...(node.data || {}) }));
    },
  };
}

function releasedDetails(message) {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(civicDetailsDecision(message)),
    { customerMessage: message, catalogItems: catalog }
  );
  return {
    ...parsed,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

test("1. explicit current catalog item beats stale historical booking on a new informational ask", () => {
  const message = "Civic mein child seat hai?";
  assert.equal(
    parseCloudDmOwnershipDecision(JSON.stringify(staleOldBookingChildSeat(message)), {
      customerMessage: message,
      catalogItems: catalog,
    }),
    null
  );
});

test("2. genuine old-booking questions still select OLD_BOOKING_REFERENCE", () => {
  const statusMessage = "meri booking ka status?";
  const statusParsed = parseCloudDmOwnershipDecision(
    JSON.stringify(genuineOldBookingStatus()),
    { customerMessage: statusMessage, catalogItems: catalog }
  );
  assert.equal(statusParsed.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(statusParsed.factKind, "booking_fact");
  assert.equal(statusParsed.targetId, BOOKING_ID);

  const pickupMessage = "jo Civic book ki thi uska pickup kab hai?";
  const pickupParsed = parseCloudDmOwnershipDecision(
    JSON.stringify(genuineOldBookingCivicPickup(pickupMessage)),
    { customerMessage: pickupMessage, catalogItems: catalog }
  );
  assert.equal(pickupParsed.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(pickupParsed.factKind, "booking_fact");
  assert.equal(pickupParsed.targetId, BOOKING_ID);
});

test("3. Civic mein child seat hai? resolves current Civic, not old booking", async () => {
  const message = "Civic mein child seat hai?";
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: catalog },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      const payload =
        calls === 1 ? staleOldBookingChildSeat(message) : civicDetailsDecision(message);
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(
    result.ownershipCorrectionReason,
    "OLD_BOOKING_EXPLICIT_CURRENT_CATALOG_SPAN"
  );
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
  assert.equal(result.decision.semanticIntent, "details_inquiry");
  assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
  assert.equal(
    resolveCanonicalItemReferents(result.decision.itemReferents, catalog)[0].itemId,
    CIVIC_ID
  );
});

test("4-5. unsupported/null/no-source fact cannot enter definitive factual compose", async () => {
  let openaiCalls = 0;
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: { business: { name: "Prod" }, catalogItems: catalog },
    userMessage: "Civic mein child seat hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        { entity: "saved_owner_answer", concept: "other", attributes: ["answer"] },
      ],
      informationalReplyDeferred: true,
    },
    factResolution: {
      status: "unsupported",
      factAvailable: false,
      verifiedValue: null,
      source: null,
      items: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attribute: "answer",
          status: "unsupported",
          verifiedValue: null,
          source: null,
        },
      ],
    },
    __chatCompletionsCreateForTests: async () => {
      openaiCalls += 1;
      return composeJson("Honda Civic mein child seat nahi hai.");
    },
  });
  assert.equal(openaiCalls, 0);
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
  assert.equal(isTrustedVerifiedFactResolution(composed.factResolution), false);
  assert.doesNotMatch(String(composed.reply), /nahi hai|unavailable|false/i);
});

test("6-8. understood missing business fact uses existing owner flow, dedupes, and returns to same customer", async () => {
  const fake = createFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const ownerSends = [];
  const message = "Civic mein child seat hai?";
  const live = await runBrainV2LivePipeline({
    traceId: "c1-missing-fact",
    businessId: BUSINESS_ID,
    message,
    messageId: "wamid.child-seat-c1",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: releasedDetails(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async (to, text) => {
        ownerSends.push({ to, text });
        return { ok: true, providerMessageId: "wamid.owner-c1" };
      },
    },
  });
  assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
  assert.doesNotMatch(String(live.reply), /nahi hai/i);
  assert.doesNotMatch(String(live.reply), /\bowner\b|\bstaff\b|\bPA\b/i);
  const rows = fake.listMissingInfo(BUSINESS_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, CIVIC_ID);
  assert.equal(rows[0].bookingId, null);
  assert.equal(rows[0].scopeKind, "catalog_item");
  assert.equal(rows[0].customerPhone, CUSTOMER_PHONE);
  assert.equal(ownerSends.length, 1);

  const replay = await runBrainV2LivePipeline({
    traceId: "c1-missing-fact-dedupe",
    businessId: BUSINESS_ID,
    message,
    messageId: "wamid.child-seat-c1",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: releasedDetails(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
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

  const customerSends = [];
  const followup = await handlePaMissingInfoOwnerAnswerInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    senderPhone: OWNER_PHONE,
    messageText: "Haan, Civic mein child seat available hai.",
    messageId: "wamid.owner-answer-c1",
    contextMessageId: "wamid.owner-c1",
    missingInfoEnabled: true,
    ownerAnswerEnabled: true,
    sendWhatsAppMessageFn: async (to, text) => {
      customerSends.push({ to, text });
      return { ok: true, providerMessageId: "wamid.cust-c1" };
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
});

test("9. known trusted fact answers directly without owner notification", async () => {
  let openaiCalls = 0;
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: {
      business: { name: "Prod", driverPolicy: "Self drive only" },
      known: { driverPolicy: "Self drive only" },
    },
    userMessage: "driver available hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        { entity: "business_profile", concept: "driver", attributes: ["policy"] },
      ],
      informationalReplyDeferred: true,
    },
    factResolution: {
      status: "found",
      factAvailable: true,
      verifiedValue: "Self drive only",
      source: "business.driverPolicy",
      items: [
        {
          entity: "business_profile",
          concept: "driver",
          attribute: "policy",
          status: "found",
          verifiedValue: "Self drive only",
          source: "business.driverPolicy",
        },
      ],
    },
    __chatCompletionsCreateForTests: async () => {
      openaiCalls += 1;
      return composeJson("Self drive only hai.", {
        coveredEvidenceKeys: ["business_profile.driver.policy"],
      });
    },
  });
  assert.equal(openaiCalls, 1);
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /Self drive only/i);

  const fake = createFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const message = "driver available hai?";
  const live = await runBrainV2LivePipeline({
    traceId: "c1-known-driver",
    businessId: BUSINESS_ID,
    message,
    messageId: "wamid.driver-known",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "general_business_question",
      itemScope: "none",
      itemReferents: [],
      itemReferenceMode: "NONE",
      targetReference: noneTarget(),
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "driver_policy",
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        { entity: "business_profile", concept: "driver", attributes: ["policy"] },
      ],
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({ driverPolicy: "Self drive only" }),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => {
        throw new Error("known fact must not notify owner");
      },
    },
  });
  assert.notEqual(live.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
});

test("10. unclear/unrepresentable question does not create a pointless owner request", async () => {
  const fake = createFakeDb();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  const live = await runBrainV2LivePipeline({
    traceId: "c1-unclear",
    businessId: BUSINESS_ID,
    message: "mujhe details chahiye",
    messageId: "wamid.vague",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: {
      turnScope: "UNCLEAR",
      semanticIntent: "unclear",
      itemScope: "none",
      itemReferents: [],
      itemReferenceMode: "NONE",
      targetReference: noneTarget(),
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "vague",
      capability: "clarification_needed",
      evidenceNeeds: [],
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    executionContext: {
      db: fake.db,
      ownerNotificationPhone: OWNER_PHONE,
      sendWhatsAppMessageFn: async () => {
        throw new Error("unclear must not notify owner");
      },
    },
  });
  assert.notEqual(live.customerTurnOutcome, "OWNER_CHECK");
  assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);

  const gate = canEscalatePostConfirmMissingInfo({
    decision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "unclear",
      factKind: "vague",
      mutationIntent: "none",
      action: "reply",
    },
    facts: { booking: { id: BOOKING_ID } },
    factResolution: { status: "unsupported", missingInfoType: null },
    missingInfoEnabled: true,
    ownerAnswerEnabled: true,
    isFactMissingFn: () => true,
  });
  assert.equal(gate.outcome, PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED);
});

test("11. generic attributes are protected without per-attribute logic", () => {
  const attributes = [
    "Civic mein child seat hai?",
    "Civic mein GPS hai?",
    "Civic ki fuel policy kya hai?",
    "Civic ki insurance included hai?",
    "Civic ke sath driver available hai?",
    "Civic ki delivery/pickup kahan se hai?",
  ];
  for (const message of attributes) {
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(civicDetailsDecision(message)),
      { customerMessage: message, catalogItems: catalog }
    );
    assert.equal(parsed.turnScope, "NEW_TRANSACTION", message);
    assert.equal(parsed.semanticIntent, "details_inquiry", message);
    assert.equal(parsed.itemReferenceMode, "CURRENT_TURN", message);
    assert.equal(
      resolveCanonicalItemReferents(parsed.itemReferents, catalog)[0].itemId,
      CIVIC_ID,
      message
    );
  }
  const ownership = readFileSync(
    join(ROOT, "../src/brain/decisions/decidePostConfirmCustomerDm.js"),
    "utf8"
  );
  const helperStart = ownership.indexOf(
    "function staleHistoricalNamedCatalogRejection"
  );
  const helperEnd = ownership.indexOf(
    "Strip PA pre-own fields",
    helperStart
  );
  const helper = ownership.slice(helperStart, helperEnd);
  assert.match(helper, /OLD_BOOKING_EXPLICIT_CURRENT_CATALOG_SPAN/);
  assert.doesNotMatch(helper, /child seat|fuel policy|GPS|insurance/);
  const pipeline = readFileSync(
    join(ROOT, "../src/brain/live/brainV2LivePipeline.js"),
    "utf8"
  );
  assert.match(pipeline, /isCloudMissingBusinessFactIntent/);
  assert.doesNotMatch(
    pipeline.slice(
      pipeline.indexOf("async function maybeCloudMissingFactOwnerCheckResult"),
      pipeline.indexOf("function isCloudUnclearOrSocialOwnership")
    ),
    /child seat|fuel policy|GPS/
  );
});
