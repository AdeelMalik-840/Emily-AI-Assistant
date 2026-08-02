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
} = await import("../src/services/customerBusinessPaAgentService.js");
const {
  canEscalatePostConfirmMissingInfo,
  PA_MISSING_INFO_GATE_OUTCOME,
  isPostConfirmFactualInformationalSemanticDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { resolvePostConfirmRequestedFact } = await import(
  "../src/brain/facts/resolvePostConfirmRequestedFact.js"
);

/** Local test helper only — production no longer keyword-routes post-booking intent. */
function classifyCustomerBusinessPaActionIntent(messageText) {
  const text = String(messageText ?? "").trim();
  return {
    isAction: false,
    reason: text ? "openai_owns_post_booking_intent" : "empty",
  };
}
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
  customerIntent = null,
  shouldReply = null,
  languageStyle = null,
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
  const intentValue =
    customerIntent ||
    (escalate
      ? "ask_fact"
      : act === "thanks"
        ? "thanks"
        : act === "acknowledgement"
          ? "ack"
          : "unclear");
  const shouldReplyValue =
    shouldReply != null
      ? shouldReply
      : decisionAction !== "silence" && decisionAction !== "none";
  const replyText = shouldReplyValue === false ? "" : customerReply;
  const inferredLang =
    languageStyle ||
    (/\b(hai|hain|hun|hoon|karke|batata|bata|ji|gaya|tha|thi|the|ke|ki|ka|liye|dena|hoga|hogi|kar|welcome\s+ji)\b/i.test(
      String(replyText || "")
    )
      ? "roman_urdu"
      : "english");
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            situation: situationValue,
            conversationAct: act,
            customerIntent: intentValue,
            customerIsAskingQuestion: asking,
            requestedInfoType: escalate ? missingInfoType : null,
            shouldReply: shouldReplyValue,
            customerReply: replyText,
            action: decisionAction,
            needsFollowup,
            missingInfoType,
            replySemantics: {
              claims: [],
              languageStyle: inferredLang,
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
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
      if (resolved.facts.replyGuardFacts) {
        resolved.facts.replyGuardFacts.advanceAmount = opts.advanceAmount;
      }
    }
    if (resolved.ok && resolved.facts?.known && "advancePolicy" in opts) {
      resolved.facts.known.advancePolicy = opts.advancePolicy;
      if (resolved.facts.business) {
        resolved.facts.business.advancePolicy = opts.advancePolicy;
      }
    }
    if (resolved.ok && resolved.facts?.known && "deliveryPolicy" in opts) {
      resolved.facts.known.deliveryPolicy = opts.deliveryPolicy;
      if (resolved.facts.business) {
        resolved.facts.business.deliveryPolicy = opts.deliveryPolicy;
      }
    }
    if (resolved.ok && resolved.facts?.known && "driverPolicy" in opts) {
      resolved.facts.known.driverPolicy = opts.driverPolicy;
      if (resolved.facts.business) {
        resolved.facts.business.driverPolicy = opts.driverPolicy;
      }
    }
    return resolved;
  };
}

/** Deferred informational Turn Plan for a business-profile policy ask. */
function deferredPolicyTurnPlan({
  concept = "advance",
  attributes = ["amount", "policy"],
  capability = "answer_from_business_profile",
} = {}) {
  return {
    ok: true,
    source: "openai",
    decision: {
      situation: "new_question",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: null,
      capability,
      evidenceNeeds: [{ entity: "business_profile", concept, attributes }],
      shouldReply: true,
      customerReply: "",
      action: "reply",
      mutationIntent: "none",
      mutationExecutionRequested: false,
      mutationExecutionStatus: "not_executed",
      actionParameters: {},
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: BOOKING_ID,
      candidateGroundings: [],
      informationalReplyDeferred: true,
    },
  };
}

/** Deferred freeform business-fact Turn Plan (saved_owner_answer / other). */
function deferredFreeformOtherTurnPlan() {
  return {
    ok: true,
    source: "openai",
    decision: {
      situation: "new_question",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: null,
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: ["answer"],
        },
      ],
      shouldReply: true,
      customerReply: "",
      action: "reply",
      mutationIntent: "none",
      mutationExecutionRequested: false,
      mutationExecutionStatus: "not_executed",
      actionParameters: {},
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: BOOKING_ID,
      candidateGroundings: [],
      informationalReplyDeferred: true,
    },
  };
}

function captureSend() {
  const ownerSends = [];
  const customerSends = [];
  return {
    ownerSends,
    customerSends,
    sendWhatsAppMessageFn: async (to, text) => {
      const digits = String(to ?? "").replace(/\D/g, "");
      if (digits === OWNER_PHONE || String(to).includes(OWNER_PHONE)) {
        ownerSends.push({ to, text });
      } else {
        customerSends.push({ to, text });
      }
      return { ok: true, messages: [{ id: `wamid.out-${ownerSends.length + customerSends.length}` }] };
    },
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

test("canEscalatePostConfirmMissingInfo returns lifecycle outcomes", () => {
  const decision = deferredPolicyTurnPlan().decision;
  const facts = {
    booking: { id: BOOKING_ID },
    known: {},
    business: {},
    openMissingInfoRequests: [],
  };
  assert.equal(
    canEscalatePostConfirmMissingInfo({
      decision,
      facts,
      factResolution: {
        status: "not_found",
        missingInfoType: "advance",
      },
      missingInfoEnabled: true,
      ownerAnswerEnabled: true,
      isFactMissingFn: isPaMissingInfoFactMissing,
    }).outcome,
    PA_MISSING_INFO_GATE_OUTCOME.CREATE_AND_NOTIFY
  );
  assert.equal(
    canEscalatePostConfirmMissingInfo({
      decision,
      facts,
      factResolution: {
        status: "found",
        missingInfoType: null,
        verifiedValue: 5000,
      },
      missingInfoEnabled: true,
      ownerAnswerEnabled: true,
      isFactMissingFn: isPaMissingInfoFactMissing,
    }).outcome,
    PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED
  );
  assert.equal(
    canEscalatePostConfirmMissingInfo({
      decision,
      facts,
      factResolution: { status: "not_found", missingInfoType: "advance" },
      missingInfoEnabled: true,
      ownerAnswerEnabled: false,
      isFactMissingFn: isPaMissingInfoFactMissing,
    }).outcome,
    PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED
  );
  assert.equal(
    canEscalatePostConfirmMissingInfo({
      decision,
      facts: {
        ...facts,
        openMissingInfoRequests: [
          {
            requestId: "pamiss_failed",
            missingInfoType: "advance",
            status: "open",
            ownerNotifyStatus: "failed",
          },
        ],
      },
      factResolution: { status: "not_found", missingInfoType: "advance" },
      missingInfoEnabled: true,
      ownerAnswerEnabled: true,
      isFactMissingFn: isPaMissingInfoFactMissing,
    }).outcome,
    PA_MISSING_INFO_GATE_OUTCOME.REUSE_AND_NOTIFY
  );
  assert.equal(
    canEscalatePostConfirmMissingInfo({
      decision,
      facts: {
        ...facts,
        openMissingInfoRequests: [
          {
            requestId: "pamiss_sent",
            missingInfoType: "advance",
            status: "owner_notified",
            ownerNotifyStatus: "sent",
          },
        ],
      },
      factResolution: { status: "not_found", missingInfoType: "advance" },
      missingInfoEnabled: true,
      ownerAnswerEnabled: true,
      isFactMissingFn: isPaMissingInfoFactMissing,
    }).outcome,
    PA_MISSING_INFO_GATE_OUTCOME.ALREADY_PENDING
  );
});

test("missing advance with flags ON creates request, notifies owner, checking reply", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      messageId: "wamid.miss-1",
      sendCredentials: {},
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "not_found");
        assert.equal(p.factResolution?.missingInfoType, "advance");
        assert.equal(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, true);
    assert.ok(result.missingInfoRequestId);
    assert.equal(result.missingInfoType, "advance");
    assert.equal(result.ownerNotifyStatus, "sent");
    assert.match(result.reply, /confirm karke batata/i);
    assert.equal(sends.ownerSends.length, 1);
    assert.match(String(sends.ownerSends[0].text), /pamiss_/i);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
  });
});

test("duplicate missing advance does not create second request or re-notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const common = {
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendCredentials: {},
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => ({
        ok: true,
        reply:
          p.factResolution?.ownerCheckStarted === true ||
          p.factResolution?.ownerCheckPending === true
            ? "Main yeh detail confirm karke batata hun."
            : "Yeh detail abhi confirm nahi hui.",
        source: "openai",
      }),
    };

    const first = await handleCustomerBusinessPaInbound({
      ...common,
      messageId: "wamid.a",
    });
    const resolveFacts2 = async (p) => {
      const resolved = await resolveFacts(p);
      if (resolved?.ok && resolved.facts) {
        resolved.facts.openMissingInfoRequests = fake
          .listMissingInfo(BUSINESS_ID)
          .filter((row) =>
            ["open", "owner_notified", "failed"].includes(row.status)
          )
          .map((row) => ({
            requestId: row.requestId,
            missingInfoType: row.missingInfoType,
            status: row.status,
            ownerNotifyStatus: row.ownerNotifyStatus,
          }));
      }
      return resolved;
    };
    const second = await handleCustomerBusinessPaInbound({
      ...common,
      messageId: "wamid.b",
      __resolveActiveCustomerBookingFactsFn: resolveFacts2,
    });

    assert.equal(first.missingInfoEscalated, true);
    assert.equal(first.ownerNotifyStatus, "sent");
    assert.equal(second.missingInfoEscalated, false);
    assert.match(second.reply, /confirm karke batata/i);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(first.sentReply, false);
    assert.equal(second.sentReply, false);
  });
});

test("missing-info flag OFF creates no request and no owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: false }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Yeh detail abhi confirm nahi hui.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.missingInfoRequestId, null);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.match(result.reply, /confirm nahi/i);
  });
});

test("known advance does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, { advanceAmount: 5000 });
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "found");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return { ok: true, reply: "Advance 5000 hai.", source: "openai" };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.match(result.reply, /5000/);
  });
});

test("notify failure does not authorize checking promise", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      messageId: "wamid.notify-fail",
      __sendWhatsAppMessageFn: async () => {
        throw new Error("WHATSAPP_API_FAILED");
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Yeh detail abhi confirm nahi hui.",
          source: "openai",
        };
      },
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.ownerNotifyStatus, "failed");
    assert.ok(result.missingInfoRequestId);
    assert.match(result.reply, /confirm nahi/i);
    assert.doesNotMatch(result.reply, /confirm karke batata|I'll confirm/i);
  });
});

test("notify fail then next ask reuses request, retries notify, checking reply", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();
  let ownerAttempts = 0;

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const failOnceSend = async (to, text) => {
      const digits = String(to ?? "").replace(/\D/g, "");
      if (digits === OWNER_PHONE || String(to).includes(OWNER_PHONE)) {
        ownerAttempts += 1;
        if (ownerAttempts === 1) {
          throw new Error("WHATSAPP_API_FAILED");
        }
        sends.ownerSends.push({ to, text });
        return { ok: true, messages: [{ id: "wamid.retry-ok" }] };
      }
      sends.customerSends.push({ to, text });
      return { ok: true, messages: [{ id: "wamid.c" }] };
    };

    const first = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      messageId: "wamid.fail-1",
      sendCredentials: {},
      __sendWhatsAppMessageFn: failOnceSend,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        assert.notEqual(p.factResolution?.ownerCheckPending, true);
        return {
          ok: true,
          reply: "Yeh detail abhi confirm nahi hui.",
          source: "openai",
        };
      },
    });

    assert.equal(first.ownerNotifyStatus, "failed");
    assert.ok(first.missingInfoRequestId);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.doesNotMatch(first.reply, /confirm karke batata/i);
    assert.equal(first.sentReply, false);

    const requestId = first.missingInfoRequestId;
    const resolveFacts2 = async (p) => {
      const resolved = await resolveFacts(p);
      if (resolved?.ok && resolved.facts) {
        resolved.facts.openMissingInfoRequests = fake
          .listMissingInfo(BUSINESS_ID)
          .filter((row) =>
            ["open", "owner_notified", "failed"].includes(row.status)
          )
          .map((row) => ({
            requestId: row.requestId,
            missingInfoType: row.missingInfoType,
            status: row.status,
            ownerNotifyStatus: row.ownerNotifyStatus,
          }));
      }
      return resolved;
    };

    const second = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna dena hoga?",
      messageId: "wamid.retry-2",
      sendCredentials: {},
      __sendWhatsAppMessageFn: failOnceSend,
      __resolveActiveCustomerBookingFactsFn: resolveFacts2,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(second.missingInfoEscalated, true);
    assert.equal(second.missingInfoRequestId, requestId);
    assert.equal(second.ownerNotifyStatus, "sent");
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(ownerAttempts, 2);
    assert.match(second.reply, /confirm karke batata/i);
    assert.equal(second.sentReply, false);
  });
});

test("failed open request with flags OFF does not retry notify", async () => {
  const fake = createFakeDb();
  const now = new Date();
  fake.setOwnerPhone(BUSINESS_ID, OWNER_PHONE);
  fake.seedBooking(BUSINESS_ID, BOOKING_ID, baseApprovedBooking());
  fake.ensureBusiness(BUSINESS_ID).paMissingInfoRequests["pamiss_failed_adv"] = {
    data: {
      requestId: "pamiss_failed_adv",
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      bookingId: BOOKING_ID,
      missingInfoType: "advance",
      customerQuestion: "Advance kitna?",
      status: "open",
      ownerNotifyStatus: "failed",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  };
  const sends = captureSend();
  let createCalled = false;

  await withFlags({ pa: true, missingInfo: false, ownerAnswer: false }, async () => {
    const facts = await resolveActiveCustomerBookingFacts({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      getBusinessProfileFn: async () => ({ businessName: "Emily Cars" }),
    });

    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        assert.notEqual(p.factResolution?.ownerCheckPending, true);
        return {
          ok: true,
          reply: "Yeh detail abhi confirm nahi hui.",
          source: "openai",
        };
      },
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.doesNotMatch(result.reply, /confirm karke batata/i);
    assert.equal(result.sentReply, false);
  });
});

test("action intent kar do reaches OpenAI and does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let openaiCalls = 0;
  let createCalled = false;

  assert.equal(classifyCustomerBusinessPaActionIntent("kar do").isAction, false);

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "kar do",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  situation: "unclear",
                  conversationAct: "action_request",
                  customerIntent: "ask_action",
                  customerIsAskingQuestion: false,
                  requestedInfoType: null,
                  shouldReply: true,
                  customerReply: "Kaunsi detail update karni hai?",
                  action: "reply",
                  mutationIntent: "none",
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
      },
    });

    assert.equal(result.handled, true);
    assert.ok(openaiCalls >= 1);
    assert.equal(result.openaiUsed, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(result.reply, "Kaunsi detail update karni hai?");
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
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Delivery available hai?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () =>
        deferredPolicyTurnPlan({
          concept: "delivery",
          attributes: ["policy"],
        }),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "found");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Pickup Johar Town se hai, Lahore delivery cover hai.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
  });
});

test("unknown advance with flags ON escalates and sends checking reply", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, {
    profile: {
      businessName: "Emily Cars",
      profileData: {
        logistics: { defaultPickupLocation: "Office" },
      },
    },
  });
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.missingInfoType, "advance");
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("advance does not escalate when advancePolicy exists", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, {
    profile: {
      businessName: "Emily Cars",
      profileData: {
        policies: { advancePolicy: "50% advance booking confirm par." },
      },
    },
  });
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "found");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Advance 50% booking confirm par hota hai.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(sends.ownerSends.length, 0);
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
  assert.equal(typeof mod.executePostConfirmPaLaneDecision, "function");
  assert.equal(typeof mod.canEscalatePostConfirmMissingInfo, "function");
  assert.equal(typeof mod.parsePostConfirmCustomerDmDecision, "function");
  assert.ok(mod.POST_CONFIRM_SITUATIONS.includes("new_question"));
  assert.ok(
    mod.POST_CONFIRM_SITUATIONS.includes("acknowledgement_after_answer")
  );
});

test("shared decideCustomerTurn exists and post-confirm wrapper stays compatible", async () => {
  const shared = await import("../src/brain/decisions/decideCustomerTurn.js");
  const post = await import(
    "../src/brain/decisions/decidePostConfirmCustomerDm.js"
  );
  assert.equal(typeof shared.decideCustomerTurn, "function");
  assert.equal(typeof shared.normalizeTurnContext, "function");
  assert.equal(typeof post.decidePostConfirmCustomerDm, "function");
  assert.ok(shared.CUSTOMER_TURN_LANES.includes("post_confirm_pa"));

  const ctx = shared.normalizeTurnContext({
    lane: "post_confirm_pa",
    messageText: "thanks",
    facts: { businessId: BUSINESS_ID, booking: { id: BOOKING_ID } },
  });
  assert.equal(ctx.lane, "post_confirm_pa");
  assert.equal(ctx.messageText, "thanks");
  assert.equal(ctx.businessId, BUSINESS_ID);
  assert.equal(ctx.activeBooking?.id, BOOKING_ID);
  assert.equal(ctx.pendingPromises, null);

  const decisionJson = {
    situation: "conversation_closing",
    conversationAct: "chit_chat",
    customerIntent: "farewell",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: false,
    customerReply: "",
    action: "silence",
  };
  let openaiCalls = 0;
  const decided = await shared.decideCustomerTurn({
    lane: "post_confirm_pa",
    messageText: "Have a good day",
    facts: { businessId: BUSINESS_ID, booking: { id: BOOKING_ID } },
    __chatCompletionsCreateForTests: async () => {
      openaiCalls += 1;
      return {
        choices: [{ message: { content: JSON.stringify(decisionJson) } }],
      };
    },
  });
  assert.ok(openaiCalls >= 1);
  assert.equal(decided.ok, true);
  assert.equal(decided.lane, "post_confirm_pa");
  assert.equal(decided.decision.action, "silence");
  assert.equal(decided.decision.shouldReply, false);
  assert.equal(decided.decision.conversationStage, "conversation_closing");
  assert.equal(decided.decision.actionType, "silence");
  assert.equal(decided.decision.requiredExecutor, "none");

  // Compat wrapper still works and routes through shared entrypoint.
  const viaCompat = await post.decidePostConfirmCustomerDm({
    facts: { businessId: BUSINESS_ID, booking: { id: BOOKING_ID } },
    userMessage: "Have a good day",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify(decisionJson) } }],
    }),
  });
  assert.equal(viaCompat.ok, true);
  assert.equal(viaCompat.lane, "post_confirm_pa");
  assert.equal(viaCompat.decision.action, "silence");

  // Unsupported lanes do not invent a second Brain path — soft fallback only.
  const unsupported = await shared.decideCustomerTurn({
    lane: "group_availability",
    messageText: "hello",
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, "UNSUPPORTED_LANE");
});

test("PA agent imports shared Brain decideCustomerTurn, not a PA Brain", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const agentSrc = await fs.readFile(
    path.join(root, "src/services/customerBusinessPaAgentService.js"),
    "utf8"
  );
  assert.match(agentSrc, /decideCustomerTurn/);
  assert.match(
    agentSrc,
    /from ["']\.\.\/brain\/decisions\/decideCustomerTurn\.js["']/
  );
  assert.doesNotMatch(agentSrc, /PA Brain|paBrain|createPaBrain/i);
  assert.doesNotMatch(
    agentSrc,
    /decidePostConfirmCustomerDm\s*\(/
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
      __sendWhatsAppMessageFn: async (to) => {
        if (String(to).replace(/\D/g, "") === OWNER_PHONE) ownerNotifyCalls += 1;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __decideCustomerTurnFn: async () => ({
        ok: true,
        source: "openai",
        decision: {
          situation: "acknowledgement_after_answer",
          conversationAct: "acknowledgement",
          customerIntent: "ack",
          customerIsAskingQuestion: false,
          requestedInfoType: null,
          capability: "social",
          evidenceNeeds: [],
          shouldReply: true,
          customerReply: "Ji theek hai.",
          action: "reply",
          mutationIntent: "none",
          mutationExecutionRequested: false,
          mutationExecutionStatus: "not_executed",
          actionParameters: {},
          bookingSelectionMode: "none",
          selectedBookingIndex: null,
          selectedBookingId: null,
          informationalReplyDeferred: false,
        },
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
      __sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => ({
        ok: true,
        source: "openai",
        decision: {
          situation: "acknowledgement_after_answer",
          conversationAct: "thanks",
          customerIntent: "thanks",
          customerIsAskingQuestion: false,
          requestedInfoType: null,
          capability: "social",
          evidenceNeeds: [],
          shouldReply: true,
          customerReply: "You're welcome.",
          action: "reply",
          mutationIntent: "none",
          mutationExecutionRequested: false,
          mutationExecutionStatus: "not_executed",
          actionParameters: {},
          bookingSelectionMode: "none",
          selectedBookingIndex: null,
          selectedBookingId: null,
          informationalReplyDeferred: false,
        },
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(result.situation, "acknowledgement_after_answer");
  });
});

test("ok driver milega? → missing driver escalates with checking reply", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "ok driver milega?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () =>
        deferredPolicyTurnPlan({
          concept: "driver",
          attributes: ["policy"],
        }),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.missingInfoType, "driver");
        assert.equal(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(result.situation, "new_question");
    assert.equal(result.conversationAct, "information_request");
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.missingInfoType, "driver");
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("Advance kitna? after ownerAnswer+followup → found answer, no escalate", async () => {
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
      __sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => ({
        ok: true,
        source: "openai",
        decision: {
          ...deferredPolicyTurnPlan().decision,
          situation: "repeat_question_answered",
        },
      }),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "found");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Advance 5000 PKR dena hoga.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.situation, "repeat_question_answered");
    assert.equal(result.reply, "Advance 5000 PKR dena hoga.");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
  });
});

test("same missing type while already notified → pending reply, no second notify", async () => {
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
  const sends = captureSend();

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
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: async () => facts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.ownerCheckPending, true);
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.missingInfoRequestId, "pamiss_open_adv");
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.match(result.reply, /confirm karke batata/i);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(result.sentReply, false);
  });
});

test("new missing advance with no open/closed answer → escalate + checking reply", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendCredentials: {},
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Main yeh detail confirm karke batata hun.",
          source: "openai",
        };
      },
    });

    assert.equal(result.situation, "new_question");
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.ownerNotifyStatus, "sent");
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});

test("unclear message → no dangerous action / no owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let createCalled = false;
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "hmm",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => ({
        ok: true,
        source: "openai",
        decision: {
          situation: "unclear",
          conversationAct: "unknown",
          customerIntent: "unclear",
          customerIsAskingQuestion: false,
          requestedInfoType: null,
          capability: "social",
          evidenceNeeds: [],
          shouldReply: true,
          customerReply: "Ji bataiye?",
          action: "reply",
          mutationIntent: "none",
          mutationExecutionRequested: false,
          mutationExecutionStatus: "not_executed",
          actionParameters: {},
          bookingSelectionMode: "none",
          selectedBookingIndex: null,
          selectedBookingId: null,
          informationalReplyDeferred: false,
        },
      }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.situation, "unclear");
    assert.equal(result.decisionAction, "reply");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
  });
});

test("missing-info ON but owner-answer OFF does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let createCalled = false;
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: false }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Advance abhi confirm nahi hai.",
          source: "openai",
        };
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
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

test("bare no/nahi is not keyword-routed away from OpenAI Brain", () => {
  for (const msg of ["no", "No", "nahi", "nahin", "nope", "cancel booking", "book kar do", "confirm kar do"]) {
    const r = classifyCustomerBusinessPaActionIntent(msg);
    assert.equal(r.isAction, false, msg);
  }
});

test("anti-echo: Have a good day near-echo is rejected for regen, not blanked", async () => {
  const {
    parsePostConfirmCustomerDmDecision,
    isNearEchoReply,
    isPostConfirmNearEchoViolation,
  } = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
  assert.equal(isNearEchoReply("Have a good day", "Have a good day"), true);
  const parsed = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "conversation_closing",
      conversationAct: "chit_chat",
      customerIntent: "farewell",
      customerIsAskingQuestion: false,
      shouldReply: true,
      customerReply: "Have a good day",
      action: "reply",
      mutationIntent: "none",
    }),
    { userMessage: "Have a good day" }
  );
  // Deterministic parse must not blank OpenAI text.
  assert.equal(String(parsed.customerReply || "").trim(), "Have a good day");
  assert.equal(
    isPostConfirmNearEchoViolation("Have a good day", parsed.customerReply, parsed),
    true
  );

  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let openaiCalls = 0;
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Have a good day",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        const reply =
          openaiCalls === 1 ? "Have a good day" : "Khuda hafiz, take care.";
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  situation: "conversation_closing",
                  conversationAct: "chit_chat",
                  customerIntent: "farewell",
                  customerIsAskingQuestion: false,
                  requestedInfoType: null,
                  shouldReply: true,
                  customerReply: reply,
                  action: "reply",
                  mutationIntent: "none",
                  replySemantics: {
                    claims: [],
                    languageStyle: "english",
                    containsTimingPromise: false,
                    exposesInternalProcess: false,
                  },
                }),
              },
            },
          ],
        };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(openaiCalls, 2);
    assert.equal(result.reply, "Khuda hafiz, take care.");
    assert.equal(result.missingInfoEscalated, false);
  });
});

test("anti-echo: you too near-echo regenerates instead of deterministic silence", async () => {
  const { parsePostConfirmCustomerDmDecision, isNearEchoReply } = await import(
    "../src/brain/decisions/decidePostConfirmCustomerDm.js"
  );
  const parsed = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "conversation_closing",
      conversationAct: "chit_chat",
      customerIntent: "farewell",
      customerIsAskingQuestion: false,
      customerReply: "you too",
      action: "reply",
      mutationIntent: "none",
    }),
    { userMessage: "you too" }
  );
  assert.equal(String(parsed.customerReply || "").trim(), "you too");
  assert.equal(isNearEchoReply("you too", parsed.customerReply || ""), true);

  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let openaiCalls = 0;
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "you too",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __appendConversationMessageFn: async () => {},
      __chatCompletionsCreateForTests: async () => {
        openaiCalls += 1;
        const reply = openaiCalls === 1 ? "you too" : "Take care!";
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  situation: "conversation_closing",
                  conversationAct: "chit_chat",
                  customerIntent: "farewell",
                  customerIsAskingQuestion: false,
                  requestedInfoType: null,
                  shouldReply: true,
                  customerReply: reply,
                  action: "reply",
                  mutationIntent: "none",
                  replySemantics: {
                    claims: [],
                    languageStyle: "english",
                    containsTimingPromise: false,
                    exposesInternalProcess: false,
                  },
                }),
              },
            },
          ],
        };
      },
    });
    assert.equal(result.handled, true);
    assert.equal(openaiCalls, 2);
    assert.equal(result.reply, "Take care!");
  });
});

test("why are you copying me → social repair, not clarification", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let sends = [];
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "why are you copying me",
      sendWhatsAppMessageFn: async (_to, text) => {
        sends.push(text);
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __appendConversationMessageFn: async () => {},
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        throw new Error("should not escalate");
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Sorry about that — that was a mistake.",
        conversationAct: "chit_chat",
        customerIntent: "social_challenge",
        situation: "social_repair",
        action: "reply",
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.situation, "social_repair");
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.reply, "Sorry about that — that was a mistake.");
    assert.doesNotMatch(result.reply, /Main samajh nahi paaya/i);
    assert.doesNotMatch(result.reply, /availability, price, ya booking/i);
    assert.equal(sends.length, 0);
    assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
  });
});

test("no after social/help context stays in PA, no ClarificationWorkflow, no pamiss", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let createCalled = false;
  let sends = [];
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    assert.equal(classifyCustomerBusinessPaActionIntent("no").isAction, false);
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "no",
      conversationHistory:
        "Assistant: Kya aap kuch aur poochna chahte hain?\nUser: no",
      sendWhatsAppMessageFn: async (_to, text) => {
        sends.push(text);
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __appendConversationMessageFn: async () => {},
      __createOrGetOpenPaMissingInfoRequestFn: async () => {
        createCalled = true;
        return { ok: false };
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "Theek hai.",
        conversationAct: "acknowledgement",
        customerIntent: "decline_more_help",
        situation: "decline_more_help",
        action: "reply",
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.situation, "decline_more_help");
    assert.equal(createCalled, false);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    for (const s of sends) {
      assert.doesNotMatch(s, /Main samajh nahi paaya/i);
    }
  });
});

test("silence action sends nothing but still handled", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  let sends = 0;
  let memory = [];
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "you too",
      sendWhatsAppMessageFn: async () => {
        sends += 1;
        return { ok: true };
      },
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __appendConversationMessageFn: async (_db, p) => {
        memory.push(p);
      },
      __chatCompletionsCreateForTests: jsonAiReply({
        customerReply: "",
        conversationAct: "chit_chat",
        customerIntent: "farewell",
        situation: "conversation_closing",
        action: "silence",
        shouldReply: false,
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.sentReply, false);
    assert.equal(sends, 0);
    assert.equal(memory.length, 0);
    assert.equal(result.reason, "HANDLED_SILENCE");
  });
});

test("PA reply is prepared for buffer delivery without local memory write", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const memory = [];
  const sends = captureSend();
  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Advance kitna?",
      sendCredentials: {},
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __appendConversationMessageFn: async (_db, p) => {
        memory.push(p);
      },
      __decideCustomerTurnFn: async () => deferredPolicyTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async () => ({
        ok: true,
        reply: "Main yeh detail confirm karke batata hun.",
        source: "openai",
      }),
    });
    assert.equal(result.handled, true);
    assert.equal(result.openaiUsed, true);
    assert.ok(String(result.reply || "").trim());
    assert.equal(result.sentReply, false);
    // Conversation memory append is owned by the Cloud buffer send path.
    assert.equal(memory.length, 0);
  });
});

test("freeform missing business facts share other escalate path (no phrase routing)", async () => {
  const messages = [
    "What is your refund policy?",
    "Fuel policy kya hai?",
    "What is your cancellation policy?",
    "Does Corolla have cruise control?",
    "Can I return this car at 11 PM?",
    "Do you provide child seats?",
    "What are the extra mileage charges?",
    "What is the accident policy?",
  ];

  for (const messageText of messages) {
    const fake = createFakeDb();
    const resolveFacts = seedActiveContext(fake);
    const sends = captureSend();

    await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
      const result = await handleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText,
        messageId: `wamid.freeform-${Buffer.from(messageText).toString("hex").slice(0, 12)}`,
        sendCredentials: {},
        __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
        __resolveActiveCustomerBookingFactsFn: resolveFacts,
        // Same Turn Plan for every freeform message — proves no phrase branching.
        __decideCustomerTurnFn: async () => deferredFreeformOtherTurnPlan(),
        __composePostConfirmInformationalCustomerReplyFn: async (p) => {
          assert.equal(p.factResolution?.status, "not_found");
          assert.equal(p.factResolution?.missingInfoType, "other");
          assert.equal(p.factResolution?.ownerCheckStarted, true);
          assert.equal(p.frozenDecision?.mutationIntent, "none");
          assert.equal(
            p.frozenDecision?.capability,
            "answer_from_saved_owner_answer"
          );
          assert.deepEqual(p.frozenDecision?.evidenceNeeds, [
            {
              entity: "saved_owner_answer",
              concept: "other",
              attributes: ["answer"],
            },
          ]);
          return {
            ok: true,
            reply: "Main yeh detail confirm karke batata hun.",
            source: "openai",
          };
        },
      });

      assert.equal(result.handled, true, messageText);
      assert.equal(result.missingInfoEscalated, true, messageText);
      assert.equal(result.missingInfoType, "other", messageText);
      assert.equal(result.ownerNotifyStatus, "sent", messageText);
      assert.equal(sends.ownerSends.length, 1, messageText);
      assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1, messageText);
      assert.equal(fake.getBooking(BUSINESS_ID, BOOKING_ID).status, "approved");
      assert.equal(result.sentReply, false, messageText);
      assert.match(result.reply, /confirm karke batata/i);
    });
  }
});

test("non-business social asks never use other escalate path", async () => {
  const messages = [
    "What time is it?",
    "What is your name?",
    "Where do you live?",
    "How are you?",
    "Tell me a joke.",
    "Who is the president?",
    "What is the weather?",
    "What is 2+2?",
    "What happened in the news today?",
    "How old are you?",
  ];

  for (const messageText of messages) {
    const fake = createFakeDb();
    const resolveFacts = seedActiveContext(fake);
    const sends = captureSend();
    let createCalled = false;

    const socialDecision = {
      ok: true,
      source: "openai",
      decision: {
        situation: "unclear",
        conversationAct: "chit_chat",
        customerIntent: "unclear",
        customerIsAskingQuestion: true,
        requestedInfoType: null,
        requestedInformation: null,
        capability: "social",
        evidenceNeeds: [],
        shouldReply: true,
        customerReply: "Main business booking help ke liye yahan hun.",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        actionParameters: {},
        bookingSelectionMode: "none",
        selectedBookingIndex: null,
        selectedBookingId: null,
        informationalReplyDeferred: false,
      },
    };

    // Question-shaped social must not force FACTUAL_TURN_PLAN_REQUIRED recovery.
    assert.equal(
      isPostConfirmFactualInformationalSemanticDecision(socialDecision.decision),
      false,
      messageText
    );

    const resolution = resolvePostConfirmRequestedFact({
      capability: socialDecision.decision.capability,
      evidenceNeeds: socialDecision.decision.evidenceNeeds,
      facts: {
        booking: { id: BOOKING_ID },
        known: {},
        business: {},
        openMissingInfoRequests: [],
        latestClosedMissingInfoAnswers: [],
      },
      selectedBooking: { id: BOOKING_ID },
      selectedBookingId: BOOKING_ID,
    });
    assert.notEqual(resolution.missingInfoType, "other", messageText);
    assert.notEqual(
      resolution.capability,
      "answer_from_saved_owner_answer",
      messageText
    );

    const gate = canEscalatePostConfirmMissingInfo({
      decision: {
        ...socialDecision.decision,
        situation: "new_question",
        conversationAct: "information_request",
        customerIsAskingQuestion: true,
      },
      facts: {
        booking: { id: BOOKING_ID },
        known: {},
        business: {},
        openMissingInfoRequests: [],
      },
      factResolution: resolution,
      missingInfoEnabled: true,
      ownerAnswerEnabled: true,
      isFactMissingFn: isPaMissingInfoFactMissing,
    });
    assert.notEqual(
      gate.outcome,
      PA_MISSING_INFO_GATE_OUTCOME.CREATE_AND_NOTIFY,
      messageText
    );

    await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
      const result = await handleCustomerBusinessPaInbound({
        db: fake.db,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText,
        __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
        __resolveActiveCustomerBookingFactsFn: resolveFacts,
        __createOrGetOpenPaMissingInfoRequestFn: async () => {
          createCalled = true;
          return { ok: false };
        },
        __decideCustomerTurnFn: async () => socialDecision,
      });

      assert.equal(result.handled, true, messageText);
      assert.equal(result.capability, "social", messageText);
      assert.notEqual(result.missingInfoType, "other", messageText);
      assert.equal(result.missingInfoEscalated, false, messageText);
      assert.equal(createCalled, false, messageText);
      assert.equal(sends.ownerSends.length, 0, messageText);
      assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0, messageText);
    });
  }
});

test("freeform other: flags OFF does not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: false, ownerAnswer: false }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Insurance policy kya hai?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: resolveFacts,
      __decideCustomerTurnFn: async () => deferredFreeformOtherTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.missingInfoType, "other");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Yeh detail abhi confirm nahi hui.",
          source: "openai",
        };
      },
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.equal(result.sentReply, false);
  });
});

test("freeform other: saved owner answer found → no escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags({ pa: true, missingInfo: true, ownerAnswer: true }, async () => {
    const result = await handleCustomerBusinessPaInbound({
      db: fake.db,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Fuel policy kya hai?",
      __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
      __resolveActiveCustomerBookingFactsFn: async (p) => {
        const resolved = await resolveFacts(p);
        if (resolved?.ok && resolved.facts) {
          resolved.facts.latestClosedMissingInfoAnswers = [
            {
              requestId: "pamiss_closed_fuel",
              missingInfoType: "other",
              ownerAnswer: "Fuel customer zimmedari hai.",
              customerFollowupText: "Fuel customer zimmedari hai.",
              customerFollowupStatus: "sent",
            },
          ];
        }
        return resolved;
      },
      __decideCustomerTurnFn: async () => deferredFreeformOtherTurnPlan(),
      __composePostConfirmInformationalCustomerReplyFn: async (p) => {
        assert.equal(p.factResolution?.status, "found");
        assert.notEqual(p.factResolution?.ownerCheckStarted, true);
        return {
          ok: true,
          reply: "Fuel customer zimmedari hai.",
          source: "openai",
        };
      },
    });

    assert.equal(result.missingInfoEscalated, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.match(result.reply, /Fuel customer/i);
    assert.equal(result.sentReply, false);
  });
});
