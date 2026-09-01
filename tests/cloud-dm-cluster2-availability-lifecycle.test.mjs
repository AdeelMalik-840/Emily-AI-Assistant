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
  applyPostConfirmDerivedOwnershipMechanics,
  parseCloudDmOwnershipDecision,
  executeCloudDmOwnershipDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { resolveCloudDmOwnershipTrustedFocus } = await import(
  "../src/services/whatsappInboundBuffer.js"
);
const {
  hydrateCloudDmContextualItemReferents,
  resolveCloudDmContextualBindIdentity,
  CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
} = await import("../src/brain/contracts/cloudCanonicalSemantic.js");
const { trustedFactsForCloudCompose } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { CUSTOMER_CLAIMS } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

const BUSINESS_ID = "biz";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const CIVIC_ID = "honda-civic";
const STONIC_ID = "kia-stonic";
const catalog = [
  {
    id: CIVIC_ID,
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    aliases: ["Civic"],
    pricing: { daily: 8000 },
  },
  {
    id: STONIC_ID,
    name: "Kia Stonic",
    displayLabel: "Kia Stonic",
    aliases: ["Stonic"],
    pricing: { daily: 7000 },
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

function civicAvailabilityDecision(message) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [span(message, "Civic")],
    targetReference: noneTarget(),
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
  };
}

function contextualFollowupDecision() {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    targetReference: noneTarget(),
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    itemReferenceMode: "CONTEXTUAL",
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

function createFakeDb() {
  const store = { businesses: {} };
  const docs = new Map();
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
      docs.set(`businesses/${rootId}/${subCollection}/${docId}`, { ...node.data });
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
    listAvrs(businessId) {
      return Object.entries(ensureBusiness(businessId).availabilityRequests || {}).map(
        ([id, node]) => ({ id, ...(node.data || {}) })
      );
    },
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

function releasedAvailability(message) {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(civicAvailabilityDecision(message)),
    { customerMessage: message, catalogItems: catalog }
  );
  return {
    ...parsed,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

test("12-13. DB available + owner-check planned returns holding only, not confirmed availability", async () => {
  await withAvrExecuteFlags(async () => {
    const fake = createFakeDb();
    fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
    const ownerSends = [];
    let availabilityCompose = 0;
    const message = "Civic 3 din ke liye chahiye";
    const live = await runBrainV2LivePipeline({
      traceId: "c2-owner-check-hold",
      businessId: BUSINESS_ID,
      message,
      messageId: "wamid.civic-3din",
      channel: "whatsapp_cloud",
      chatType: "dm",
      isGroupInbound: false,
      participantPhoneForDm: CUSTOMER_PHONE,
      catalogItems: catalog,
      canonicalSemanticDecision: releasedAvailability(message),
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      __cloudComposeChatCreate: async (args) => {
        const user = String(args?.messages?.[1]?.content ?? "");
        if (/KIND: availability\b/.test(user) && !/availability_approved/.test(user)) {
          availabilityCompose += 1;
          return composeJson("Honda Civic abhi available hai.", [
            CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          ]);
        }
        return composeJson(CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
      },
      executionContext: {
        db: fake.db,
        ownerNotificationPhone: OWNER_PHONE,
        sendWhatsAppMessageFn: async (to, text) => {
          ownerSends.push({ to, text });
          return { ok: true, providerMessageId: "wamid.owner-avr" };
        },
      },
    });
    assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
    assert.equal(live.messageMeta?.outboundTrace?.finalReplySource, "CLOUD_SEMANTIC_OWNER_CHECK");
    assert.equal(availabilityCompose, 0);
    assert.doesNotMatch(String(live.reply), /abhi available hai/i);
    assert.doesNotMatch(String(live.reply), /\bowner\b|\bstaff\b|\bPA\b/i);
    assert.equal(fake.listAvrs(BUSINESS_ID).length, 1);
    assert.equal(ownerSends.length, 1);
  });
});

test("duration-only Cloud continuation keeps the pending item and starts its owner check", async () => {
  await withAvrExecuteFlags(async () => {
    const fake = createFakeDb();
    fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
    const ownerSends = [];
    const pending = {
      type: "collect_availability_duration",
      status: "awaiting",
      pendingStage: "availability_duration",
      pendingQuestion: "rental period required",
      itemId: STONIC_ID,
      itemLabel: "Kia Stonic",
      participantKey: CUSTOMER_PHONE,
      sourceTurnKey: "wamid.stonic-duration-ask",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const memorySnapshot = { pendingAction: pending, emilyPending: pending };
    const trustedFreshItemFocus = resolveCloudDmOwnershipTrustedFocus({
      memorySnapshot,
      participantKey: CUSTOMER_PHONE,
      nowMs: Date.parse("2026-08-28T00:00:00.000Z"),
    });
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(contextualFollowupDecision()),
      {
        customerMessage: "4 din",
        trustedFreshItemFocus,
        catalogItems: catalog,
      }
    );
    const canonical = applyPostConfirmDerivedOwnershipMechanics(parsed, {
      currentCustomerMessage: "4 din",
      trustedFreshItemFocus,
      catalogItems: catalog,
    });

    const live = await runBrainV2LivePipeline({
      traceId: "duration-pending-stonic",
      businessId: BUSINESS_ID,
      message: "4 din",
      messageId: "wamid.stonic-duration-answer",
      channel: "whatsapp_cloud",
      chatType: "dm",
      participantKey: CUSTOMER_PHONE,
      participantPhoneForDm: CUSTOMER_PHONE,
      catalogItems: catalog,
      memorySnapshot,
      canonicalSemanticDecision: {
        ...canonical,
        semanticDecisionStatus: "released",
        ownershipLane: "normal_routing",
      },
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      executionContext: {
        db: fake.db,
        ownerNotificationPhone: OWNER_PHONE,
        sendWhatsAppMessageFn: async (to, text) => {
          ownerSends.push({ to, text });
          return { ok: true, providerMessageId: "wamid.owner-stonic" };
        },
      },
    });

    assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
    assert.equal(fake.listAvrs(BUSINESS_ID).length, 1);
    assert.equal(fake.listAvrs(BUSINESS_ID)[0].itemId, STONIC_ID);
    assert.equal(fake.listAvrs(BUSINESS_ID)[0].requestedDuration, 4);
    assert.equal(ownerSends.length, 1);
  });
});

test("14. normal availability composer cannot claim confirmed availability from DB isAvailable alone", async () => {
  const facts = trustedFactsForCloudCompose({
    composeKind: "availability",
    resolvedBusinessTurnContext: {
      resolvedItem: { id: CIVIC_ID, displayLabel: "Honda Civic" },
      verified: { availability: { status: "resolved", isAvailable: true } },
    },
    actionPlan: { actions: [] },
  });
  assert.equal(facts.availabilityConfirmed, false);
  assert.notEqual(facts.availabilityConfirmed, true);

  const composed = await composeCloudCanonicalCustomerReply({
    kind: "availability",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: facts,
    fallbackReply: "checking",
    __chatCompletionsCreateForTests: async (args) => {
      const system = String(args?.messages?.[0]?.content ?? "");
      assert.doesNotMatch(system, /RESOURCE_AVAILABILITY_CONFIRMED is allowed/);
      return composeJson("Civic ke baare mein check kar rahi hoon.", []);
    },
  });
  assert.equal(composed.ok, true);
  assert.doesNotMatch(composed.reply, /confirm/i);
});

test("15. approved AVR can still use availability_approved", () => {
  const composer = readFileSync(
    join(ROOT, "../src/brain/openai/composeCloudCanonicalCustomerReply.js"),
    "utf8"
  );
  assert.match(composer, /kind === "availability_approved"/);
  const notify = readFileSync(
    join(ROOT, "../src/services/availabilityCustomerNotificationService.js"),
    "utf8"
  );
  assert.match(notify, /kind: "availability_approved"/);
  const pipeline = readFileSync(
    join(ROOT, "../src/brain/live/brainV2LivePipeline.js"),
    "utf8"
  );
  const composeKind = pipeline.slice(
    pipeline.indexOf("function cloudCanonicalComposeKind"),
    pipeline.indexOf("export function trustedFactsForCloudCompose")
  );
  assert.doesNotMatch(composeKind, /availability_approved/);
});

test("16-17. one eligible pending AVR supplies continuation; mil jye ge? does not hit CONTEXTUAL_FRESH_FOCUS_MISSING", () => {
  const pending = [
    {
      requestId: "avr_civic_pending",
      itemId: CIVIC_ID,
      itemLabel: "Honda Civic",
      status: "pending",
    },
  ];
  const bind = resolveCloudDmContextualBindIdentity({
    trustedFreshItemFocus: null,
    pendingOwnerCheckRequests: pending,
  });
  assert.equal(bind.ok, true);
  assert.equal(bind.itemId, CIVIC_ID);
  assert.equal(bind.bindSource, "pending_avr");

  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(contextualFollowupDecision()),
    {
      customerMessage: "MIL JYE GE???",
      catalogItems: catalog,
      pendingOwnerCheckRequests: pending,
    }
  );
  assert.ok(parsed);
  assert.equal(parsed.itemReferenceMode, "CONTEXTUAL");
  assert.equal(parsed.itemReferents[0].trustedItemId, CIVIC_ID);
  assert.equal(parsed.itemReferents[0].sourceTurnId, "avr_civic_pending");

  const hydrated = hydrateCloudDmContextualItemReferents(
    contextualFollowupDecision().itemReferents,
    null,
    pending
  );
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.itemReferents[0].trustedItemId, CIVIC_ID);
});

test("18. explicit new item beats old pending AVR", () => {
  const message = "Stonic chahiye instead";
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      itemScope: "specific",
      itemReferents: [span(message, "Stonic")],
      targetReference: noneTarget(),
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
      capability: null,
      evidenceNeeds: [],
    }),
    {
      customerMessage: message,
      catalogItems: catalog,
      pendingOwnerCheckRequests: [
        {
          requestId: "avr_civic_pending",
          itemId: CIVIC_ID,
          status: "pending",
        },
      ],
    }
  );
  assert.equal(parsed.turnScope, "NEW_TRANSACTION");
  assert.equal(parsed.itemReferenceMode, "CURRENT_TURN");
  assert.equal(parsed.itemReferents[0].surfaceText, "Stonic");
  assert.notEqual(parsed.itemReferents[0].trustedItemId, CIVIC_ID);
});

test("19. ambiguous multiple pending AVRs do not get guessed", () => {
  const bind = resolveCloudDmContextualBindIdentity({
    trustedFreshItemFocus: null,
    pendingOwnerCheckRequests: [
      { requestId: "avr_civic", itemId: CIVIC_ID, status: "pending" },
      { requestId: "avr_stonic", itemId: STONIC_ID, status: "pending" },
    ],
  });
  assert.equal(bind.ok, false);
  assert.equal(bind.reason, "CONTEXTUAL_PENDING_AVR_AMBIGUOUS");
  assert.equal(
    parseCloudDmOwnershipDecision(JSON.stringify(contextualFollowupDecision()), {
      customerMessage: "mil jye ge?",
      catalogItems: catalog,
      pendingOwnerCheckRequests: [
        { requestId: "avr_civic", itemId: CIVIC_ID, status: "pending" },
        { requestId: "avr_stonic", itemId: STONIC_ID, status: "pending" },
      ],
    }),
    null
  );
});

test("20. no duplicate AVR / owner notification on the same planned Civic check", async () => {
  await withAvrExecuteFlags(async () => {
    const fake = createFakeDb();
    fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
    const ownerSends = [];
    const message = "Civic 3 din ke liye chahiye";
    const frozen = releasedAvailability(message);
    const run = () =>
      runBrainV2LivePipeline({
        traceId: `c2-dup-${ownerSends.length}`,
        businessId: BUSINESS_ID,
        message,
        messageId: "wamid.civic-3din-dup",
        channel: "whatsapp_cloud",
        chatType: "dm",
        isGroupInbound: false,
        participantPhoneForDm: CUSTOMER_PHONE,
        catalogItems: catalog,
        canonicalSemanticDecision: frozen,
        getBookingsForItemFn: async () => [],
        getBusinessProfileFn: async () => ({}),
        executionContext: {
          db: fake.db,
          ownerNotificationPhone: OWNER_PHONE,
          sendWhatsAppMessageFn: async (to, text) => {
            ownerSends.push({ to, text });
            return { ok: true, providerMessageId: "wamid.owner-dup" };
          },
        },
      });
    await run();
    await run();
    assert.equal(fake.listAvrs(BUSINESS_ID).length, 1);
    assert.ok(ownerSends.length <= 1);
  });
});

test("21-24. waiting-confirm, approval wording, recovery-history, and Group stay unchanged", async () => {
  const waiting = readFileSync(
    join(ROOT, "../src/brain/decisions/waitingConfirmDmLane.js"),
    "utf8"
  );
  assert.match(waiting, /action=confirm_booking/);
  const composer = readFileSync(
    join(ROOT, "../src/brain/openai/composeCloudCanonicalCustomerReply.js"),
    "utf8"
  );
  assert.match(
    composer,
    /Availability is already confirmed\. Write a short natural reply from TRUSTED_FACTS_JSON only/
  );
  const store = readFileSync(
    join(ROOT, "../src/services/conversationStore.js"),
    "utf8"
  );
  assert.match(store, /excludeFromSemanticHistory/);
  assert.match(store, /technical_recovery/);
  const groupLane = readFileSync(
    join(ROOT, "../src/brain/decisions/groupPostExecuteLane.js"),
    "utf8"
  );
  assert.match(groupLane, /GROUP_POST_EXECUTE_LANE/);
  assert.doesNotMatch(groupLane, /OLD_BOOKING_EXPLICIT_CURRENT_CATALOG_SPAN/);
  assert.doesNotMatch(groupLane, /pendingOwnerCheckRequests/);

  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: catalog },
    userMessage: "han",
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              turnScope: "SOCIAL_GENERAL",
              semanticIntent: "social",
              itemScope: "none",
              itemReferents: [],
              targetReference: noneTarget(),
              targetId: null,
              mutationIntent: "none",
              action: "reply",
              factKind: "non_business",
              capability: null,
              evidenceNeeds: [],
            }),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.turnScope, "SOCIAL_GENERAL");
});
