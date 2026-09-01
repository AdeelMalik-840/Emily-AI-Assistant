import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { resolveActiveCustomerBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);
const { handlePaMissingInfoOwnerAnswerInbound } = await import(
  "../src/services/paMissingInfoOwnerAnswerService.js"
);
const { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } = await import(
  "../src/brain/contracts/cloudCanonicalSemantic.js"
);

const BUSINESS_ID = "cloud-frozen-miss-1";
const CUSTOMER_PHONE = "923001112233";
const OWNER_PHONE = "923009998877";
const BOOKING_ID = "bk_cloud_frozen_001";
const AVR_ID = "avr_cloud_frozen_001";
const WRONG_BOOKING_ID = "bk_wrong_old_999";

function withFlags(fn) {
  const prevPa = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  const prevMiss = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevAns = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";
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

function seedActiveContext(fake, opts = {}) {
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
    if (!resolved.ok || !resolved.facts?.known) return resolved;
    const overlay = (field, value) => {
      resolved.facts.known[field] = value;
      if (resolved.facts.business) resolved.facts.business[field] = value;
      if (resolved.facts.replyGuardFacts) {
        resolved.facts.replyGuardFacts[field] = value;
      }
    };
    if ("advanceAmount" in opts) overlay("advanceAmount", opts.advanceAmount);
    if ("advancePolicy" in opts) overlay("advancePolicy", opts.advancePolicy);
    if ("deliveryPolicy" in opts) overlay("deliveryPolicy", opts.deliveryPolicy);
    if ("driverPolicy" in opts) overlay("driverPolicy", opts.driverPolicy);
    if ("documentsPolicy" in opts) overlay("documentsPolicy", opts.documentsPolicy);
    return resolved;
  };
}

/**
 * Frozen Cloud ownership snapshot. Omits situation / conversationAct /
 * customerIsAskingQuestion on purpose — production hydrate must not need them.
 */
function frozenOldBookingQuestion({
  factKind = "advance",
  targetId = BOOKING_ID,
  action = "reply",
  mutationIntent = "none",
  turnScope = "OLD_BOOKING_REFERENCE",
  semanticIntent = null,
} = {}) {
  return {
    turnScope,
    semanticIntent,
    itemScope: "none",
    itemReferents: [],
    targetContext:
      turnScope === "OLD_BOOKING_REFERENCE" ? "CONFIRMED_BOOKING" : "NONE",
    targetId,
    selectedBookingId: turnScope === "OLD_BOOKING_REFERENCE" ? targetId : null,
    mutationIntent,
    action,
    factKind,
    openaiSource: "openai",
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
      return {
        ok: true,
        providerMessageId: `wamid.out-${ownerSends.length + customerSends.length}`,
      };
    },
  };
}

function informationalCompose() {
  return async (p) => {
    if (p.factResolution?.status === "found") {
      const value = p.factResolution?.verifiedValue;
      return {
        ok: true,
        reply: `Advance ${typeof value === "object" ? JSON.stringify(value) : value} hai.`,
        source: "openai",
      };
    }
    if (
      p.factResolution?.ownerCheckStarted === true ||
      p.factResolution?.ownerCheckPending === true
    ) {
      return {
        ok: true,
        reply: CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
        source: "openai",
      };
    }
    return {
      ok: true,
      reply: "Yeh detail abhi confirm nahi hui.",
      source: "openai",
    };
  };
}

function rejectSecondBrain() {
  return async () => {
    throw new Error("second semantic Brain must not run on a frozen snapshot");
  };
}

async function runFrozenPa({
  fake,
  resolveFacts,
  sends,
  messageText,
  messageId,
  snapshot,
  extra = {},
}) {
  return handleCustomerBusinessPaInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText,
    messageId,
    sendCredentials: {},
    canonicalSemanticDecision: snapshot,
    __sendWhatsAppMessageFn: sends.sendWhatsAppMessageFn,
    __resolveActiveCustomerBookingFactsFn: resolveFacts,
    __decideCustomerTurnFn: rejectSecondBrain(),
    __composePostConfirmInformationalCustomerReplyFn: informationalCompose(),
    ...extra,
  });
}

test("1. frozen Advance kitna? with trusted advance answers from facts, no owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake, { advanceAmount: 5000 });
  const sends = captureSend();

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Advance kitna?",
      messageId: "wamid.frozen-known-advance",
      snapshot: frozenOldBookingQuestion({ factKind: "advance" }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.semanticDecisionCount, 0);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(result.factResolution?.status, "found");
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.match(String(result.reply), /5000/);
    assert.notEqual(result.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  });
});

test("2. frozen Advance kitna? with missing advance creates pamiss, notifies owner, holding after notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Advance kitna?",
      messageId: "wamid.frozen-missing-advance",
      snapshot: frozenOldBookingQuestion({ factKind: "advance" }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.semanticDecisionCount, 0);
    assert.equal(result.missingInfoEscalated, true);
    assert.equal(result.missingInfoType, "advance");
    assert.equal(result.ownerNotifyStatus, "sent");
    assert.equal(result.factResolution?.ownerCheckStarted, true);
    assert.equal(result.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
    assert.equal(sends.ownerSends.length, 1);
    assert.match(String(sends.ownerSends[0].text), /Reply to this message/i);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID)[0].missingInfoType, "advance");
    assert.equal(fake.listMissingInfo(BUSINESS_ID)[0].bookingId, BOOKING_ID);
  });
});

async function assertMissingFactEscalates({ messageText, factKind, missingInfoType }) {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText,
      messageId: `wamid.frozen-missing-${missingInfoType}`,
      snapshot: frozenOldBookingQuestion({ factKind }),
    });

    assert.equal(result.handled, true, messageText);
    assert.equal(result.semanticDecisionCount, 0, messageText);
    assert.equal(result.missingInfoEscalated, true, messageText);
    assert.equal(result.missingInfoType, missingInfoType, messageText);
    assert.equal(result.ownerNotifyStatus, "sent", messageText);
    assert.equal(sends.ownerSends.length, 1, messageText);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1, messageText);
    assert.equal(
      fake.listMissingInfo(BUSINESS_ID)[0].missingInfoType,
      missingInfoType,
      messageText
    );
  });
}

test("3. frozen Delivery kahan hogi? with missing delivery escalates to owner", async () => {
  await assertMissingFactEscalates({
    messageText: "Delivery kahan hogi?",
    factKind: "delivery_policy",
    missingInfoType: "delivery",
  });
});

test("4. frozen Driver milega? with missing driver escalates to owner", async () => {
  await assertMissingFactEscalates({
    messageText: "Driver milega?",
    factKind: "driver_policy",
    missingInfoType: "driver",
  });
});

test("5. frozen Documents kya chahiye? with missing documents escalates to owner", async () => {
  await assertMissingFactEscalates({
    messageText: "Documents kya chahiye?",
    factKind: "documents_checklist",
    missingInfoType: "documents",
  });
});

test("6. frozen Thanks social must not escalate", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();
  let createCalled = false;

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Thanks",
      messageId: "wamid.frozen-thanks",
      snapshot: frozenOldBookingQuestion({
        factKind: "non_business",
        turnScope: "SOCIAL_GENERAL",
        semanticIntent: "social",
        targetId: null,
        action: "reply",
      }),
      extra: {
        __createOrGetOpenPaMissingInfoRequestFn: async () => {
          createCalled = true;
          return { ok: false };
        },
      },
    });

    assert.equal(result.handled, false);
    assert.equal(result.ownershipReleased, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
  });
});

test("7. frozen mutation request is not routed as missing-info escalation", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();
  let createCalled = false;
  let mutationCalled = false;

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Isko 2 din extend kar do",
      messageId: "wamid.frozen-mutation",
      snapshot: frozenOldBookingQuestion({
        factKind: "action",
        action: "request_booking_mutation",
        mutationIntent: "extend_booking",
      }),
      extra: {
        __createOrGetOpenPaMissingInfoRequestFn: async () => {
          createCalled = true;
          return { ok: false };
        },
        __executePostConfirmBookingMutationFn: () => {
          mutationCalled = true;
          return { status: "not_executed", intent: "extend_booking" };
        },
        __composePostConfirmMutationCustomerReplyFn: async () => ({
          ok: true,
          reply: "Extension abhi confirm nahi hui.",
          source: "openai",
        }),
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.missingInfoEscalated, false);
    assert.equal(createCalled, false);
    assert.equal(mutationCalled, true);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
    assert.match(String(result.reply), /Extension/i);
  });
});

test("8. frozen wrong/old booking target remains fail-closed", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();
  let createCalled = false;

  await withFlags(async () => {
    const result = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Advance kitna?",
      messageId: "wamid.frozen-wrong-target",
      snapshot: frozenOldBookingQuestion({
        factKind: "advance",
        targetId: WRONG_BOOKING_ID,
      }),
      extra: {
        __createOrGetOpenPaMissingInfoRequestFn: async () => {
          createCalled = true;
          return { ok: false };
        },
      },
    });

    assert.equal(result.handled, true);
    assert.equal(result.terminalFailure, true);
    assert.equal(result.reason, "SEMANTIC_OWNERSHIP_TARGET_INVALID");
    assert.notEqual(result.missingInfoEscalated, true);
    assert.equal(createCalled, false);
    assert.equal(sends.ownerSends.length, 0);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 0);
  });
});

test("9. owner answer returns to the exact customer/booking/question and is idempotent", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();

  await withFlags(async () => {
    const first = await runFrozenPa({
      fake,
      resolveFacts,
      sends,
      messageText: "Advance kitna?",
      messageId: "wamid.frozen-owner-answer-src",
      snapshot: frozenOldBookingQuestion({ factKind: "advance" }),
    });
    assert.equal(first.missingInfoEscalated, true);
    const row = fake.listMissingInfo(BUSINESS_ID)[0];
    assert.ok(row?.id);
    assert.equal(row.customerPhone, CUSTOMER_PHONE);
    assert.equal(row.bookingId, BOOKING_ID);
    assert.equal(row.customerQuestion, "Advance kitna?");
    const notifyWamid = row.ownerNotifyProviderMessageId;
    assert.ok(notifyWamid);

    const customerFollowups = [];
    const ownerCommon = {
      __classifyOwnerResponseKindFn: async () => ({
        ok: true,
        kind: "final_answer",
        source: "test",
      }),
      db: fake.db,
      businessId: BUSINESS_ID,
      senderPhone: OWNER_PHONE,
      messageText: "Advance 7000 PKR hoga",
      messageId: "wamid.owner-frozen-1",
      contextMessageId: notifyWamid,
      sendWhatsAppMessageFn: async (to, text) => {
        customerFollowups.push({ to, text });
        return { ok: true, providerMessageId: "wamid.cust-follow-1" };
      },
      __chatCompletionsCreateForTests: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Advance 7000 PKR dena hoga.",
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
      }),
    };

    const answered = await handlePaMissingInfoOwnerAnswerInbound(ownerCommon);
    assert.equal(answered.customerFollowupSent, true);
    assert.equal(customerFollowups.length, 1);
    assert.equal(
      String(customerFollowups[0].to).replace(/\D/g, ""),
      CUSTOMER_PHONE
    );
    assert.equal(customerFollowups[0].text, "Advance 7000 PKR dena hoga.");

    const duplicate = await handlePaMissingInfoOwnerAnswerInbound(ownerCommon);
    assert.equal(duplicate.customerFollowupSent, false);
    assert.ok(
      duplicate.reason === "IDEMPOTENT_SAME_MESSAGE" ||
        /IDEMPOTENT|ALREADY/i.test(String(duplicate.reason ?? ""))
    );
    assert.equal(customerFollowups.length, 1);
  });
});

test("10. replay of the same customer source turn does not duplicate request or owner notify", async () => {
  const fake = createFakeDb();
  const resolveFacts = seedActiveContext(fake);
  const sends = captureSend();
  const common = {
    fake,
    resolveFacts,
    sends,
    messageText: "Advance kitna?",
    messageId: "wamid.frozen-replay-src",
    snapshot: frozenOldBookingQuestion({ factKind: "advance" }),
  };

  await withFlags(async () => {
    const first = await runFrozenPa(common);
    const second = await runFrozenPa(common);

    assert.equal(first.missingInfoEscalated, true);
    assert.equal(first.ownerNotifyStatus, "sent");
    assert.equal(second.missingInfoEscalated, false);
    assert.equal(second.factResolution?.ownerCheckPending, true);
    assert.equal(second.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
    assert.equal(sends.ownerSends.length, 1);
    assert.equal(fake.listMissingInfo(BUSINESS_ID).length, 1);
  });
});
