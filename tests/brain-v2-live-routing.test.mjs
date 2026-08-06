import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  isEmilyBrainV2LiveEnabledForBusiness,
  getEmilyBrainV2LiveFlagSnapshot,
} from "../src/brain/config/liveFeatureFlags.js";
import {
  routeLiveActionPlan,
  assertLiveActionPlanIsSafe,
  executeLiveSideEffects,
  routeAndExecuteLiveActionPlan,
  isLiveWorkflowType,
} from "../src/brain/live/actionRouter.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  isEmilyBrainV2LiveQuickGate,
  evaluateInboundBrainRoute,
  tryBrainV2LiveBeforeLegacy,
  executeWhatsAppAiPipeline,
  evaluateBrainRouteGate,
  isLegacyProcessMessageAllowed,
} from "../src/services/whatsappInboundBuffer.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} from "../src/brain/golden/goldenHarness.js";
import { patchEmilySessionState, getEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveTrustedPreviousItemContinuation as __hasSafePreviousCatalogItemForPriceFollowupForTests } from "../src/brain/context/previousItemContinuationResolver.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";
import { executeOwnerNotification } from "../src/services/executors/ownerNotificationExecutor.js";
import { executeReplyPrivate } from "../src/services/executors/replyPrivateExecutor.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const OTHER_BUSINESS = "other-business-not-allowlisted";
const PARTICIPANT_A = "scope::participant-a";
const SESSION_A = `${BUSINESS_ID}::car-rental-queries::participant::${PARTICIPANT_A}`;

const envBackup = {
  EMILY_BRAIN_V2_LIVE: process.env.EMILY_BRAIN_V2_LIVE,
  EMILY_BRAIN_V2_LIVE_BUSINESSES: process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES,
  EMILY_BRAIN_V2_PRODUCTION_ALLOW: process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW,
  EMILY_BRAIN_V2_LEGACY_FALLBACK: process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK,
  EMILY_BRAIN_V2_BOOKING_EXECUTE: process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE,
  EMILY_BRAIN_V2_OWNER_EXECUTE: process.env.EMILY_BRAIN_V2_OWNER_EXECUTE,
  EMILY_BRAIN_V2_DM_EXECUTE: process.env.EMILY_BRAIN_V2_DM_EXECUTE,
  EMILY_BRAIN_V2_INFO_LIVE: process.env.EMILY_BRAIN_V2_INFO_LIVE,
};

function createFakeBookingDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= { data: {}, bookings: {}, bookingSourceKeys: {} };
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
    _node() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        const id = this.path[i + 1];
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
      const nextId = id == null ? `booking-${++autoId}` : String(id);
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
    const [rootCollection, rootId, subCollection, docId] = ref.path;
    if (rootCollection !== "businesses" || !rootId || !subCollection || !docId) {
      throw new Error(`unsupported fake path ${ref.path.join("/")}`);
    }
    const business = ensureBusiness(rootId);
    business[subCollection] ||= {};
    business[subCollection][docId] ||= { data: {} };
    business[subCollection][docId].data = {
      ...business[subCollection][docId].data,
      ...data,
    };
  }

  const db = {
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

  function seedBooking(id, data) {
    const business = ensureBusiness(BUSINESS_ID);
    business.bookings[id] = { data: { ...data } };
  }

  return { db, store, seedBooking };
}

function seedActiveCorollaBooking(fake) {
  fake.seedBooking("existing-corolla-booking", {
    itemId: "corolla-1",
    itemName: "Toyota Corolla",
    status: "approved",
    startAt: new Date(Date.now() - 86400000),
    endAt: new Date(Date.now() + 86400000 * 5),
  });
}

function bookingRequestPlan({ itemId = "corolla-1", itemName = "Toyota Corolla", durationDays = 3 } = {}) {
  return {
    workflowType: "booking_request",
    planId: `booking-${itemId}`,
    replyDraft: "Theek hai, mai check kr k btata hun.",
    actions: [
      {
        type: "REPLY",
        payload: { text: "Theek hai, mai check kr k btata hun." },
      },
      {
        type: "CREATE_BOOKING",
        payload: { execute: true, itemId, itemName, durationDays },
      },
      {
        type: "NOTIFY_OWNER",
        payload: { execute: true },
      },
    ],
  };
}

function enableV2LiveForSyntheticBusiness() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  delete process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_OWNER_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_DM_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_INFO_LIVE;
}

test.afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("A: flags off still routes every supported business to Brain V2", () => {
  delete process.env.EMILY_BRAIN_V2_LIVE;
  assert.equal(
    evaluateInboundBrainRoute({ businessId: BUSINESS_ID }),
    "v2_live"
  );
});

test("B: inbound production pipeline contains no legacy processMessage route", () => {
  delete process.env.EMILY_BRAIN_V2_LIVE;
  const source = executeWhatsAppAiPipeline.toString();
  assert.doesNotMatch(source, /processMessageFn|processMessage\s*\(/);
  assert.equal(evaluateInboundBrainRoute({ businessId: BUSINESS_ID }), "v2_live");
});

test("C: V2 route never authorizes legacy semantic fallback", async () => {
  enableV2LiveForSyntheticBusiness();
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);

  const gate = evaluateBrainRouteGate({
    businessId: BUSINESS_ID,
    env: process.env,
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(
    isLegacyProcessMessageAllowed({ routeGate: gate, handledByBrainV2Live: false }),
    false
  );

  const source = executeWhatsAppAiPipeline.toString();
  assert.ok(source.includes("[brain_route_gate_evaluated]"));
  assert.doesNotMatch(source, /processMessageFn|processMessage\s*\(/);
});

test("D: Civic available? handled by v2 live", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "civic-live",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.equal(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_LIVE");
});

test("E: Stonic 10-day price handled by v2 live", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "stonic-live",
    businessId: BUSINESS_ID,
    message: "Stonic 10 din ka rent kitna hai?",
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Stonic/i);
});

test("F: itemless price without trusted item asks clarification", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "itemless-live",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    memorySnapshot: {},
  });
  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("G: stable participant follow-up uses trusted v2 session item", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  patchEmilySessionState(SESSION_A, {
    lastItem: { id: civic.itemId, name: civic.itemLabel, displayLabel: civic.itemLabel },
    lastResolvedItemId: civic.itemId,
    stage: "START",
  });
  const result = await runBrainV2LivePipeline({
    traceId: "civic-followup-live",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: PARTICIPANT_A,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    memorySnapshot: getEmilySessionState(SESSION_A),
    sessionKey: SESSION_A,
    playwrightChatKey: "car-rental-queries",
    resolveTrustedSessionItem: (p) =>
      __hasSafePreviousCatalogItemForPriceFollowupForTests({
        memory: p.memory,
        message: p.message,
        catalogItems: p.catalogItems,
        participantKey: p.participantKey,
        chatContextKey: p.chatContextKey,
        sessionKey: p.sessionKey,
        traceId: p.traceId,
        isGroupInbound: p.isGroupInbound,
        continuationContextNeeded: p.continuationContextNeeded,
        continuationKind: p.continuationKind,
      }),
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Stonic/i);
});

test("H: missing identity + explicit item works", () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "Civic available?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  assert.equal(input.shouldClarifyItem, false);
  assert.equal(input.explicitItem?.id, resolveCatalogItemFromMessage(fixture, "Civic available?").itemId);
});

test("I: missing identity + itemless follow-up clarifies", () => {
  enableV2LiveForSyntheticBusiness();
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
    memorySnapshot: {},
  });
  assert.equal(input.shouldClarifyItem, true);
});

test("J: booking request produces v2 action plan", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "booking-plan",
    businessId: BUSINESS_ID,
    message: "book kr do Civic 3 din",
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "booking_request");
  assert.ok(result.messageMeta?.actionPlan);
  assert.ok(
    Array.isArray(result.messageMeta?.actionPlan?.actions) &&
      result.messageMeta.actionPlan.actions.some((a) => a.type === "CREATE_BOOKING")
  );
});

test("K: booking execution blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.bookingExecute, false);
  const routed = routeLiveActionPlan(
    {
      planId: "booking-blocked",
      replyDraft: "Booking ack",
      actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "x", durationDays: 3 } }],
    },
    flags
  );
  assert.equal(routed.hasDisallowedExecute, true);
  assert.throws(() => assertLiveActionPlanIsSafe(
    {
      planId: "bad-booking",
      actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "x", durationDays: 3 } }],
    },
    flags
  ));
});

test("L: owner notification blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.ownerExecute, false);
  await assert.rejects(
    () =>
      executeLiveSideEffects({
        actionPlan: {
          planId: "owner-blocked",
          actions: [
            {
              type: "NOTIFY_OWNER",
              payload: { execute: true },
            },
          ],
        },
        routed: routeLiveActionPlan(
          {
            planId: "owner-blocked",
            actions: [{ type: "NOTIFY_OWNER", payload: { execute: true } }],
          },
          flags
        ),
        flags,
        executionContext: { businessId: BUSINESS_ID, traceId: "owner-test" },
      }),
    /live_side_effect_blocked:NOTIFY_OWNER/
  );
});

test("M: DM blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.dmExecute, false);
  const dm = await executeReplyPrivate({
    payload: { text: "hello", recipientPhone: "923001234567" },
    executionContext: { participantPhoneForDm: "923001234567" },
  });
  assert.equal(dm.blocked, true);
});

test("N: unsafe execute:true side-effect throws", () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.throws(() =>
    assertLiveActionPlanIsSafe(
      {
        planId: "unsafe",
        actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "a", durationDays: 2 } }],
      },
      flags
    )
  );
});

test("O/P: v2 live path does not invoke legacy fuzzy or memory resolver", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "no-legacy-paths",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    memorySnapshot: { lastItem: { id: "stonic-1", name: "Kia Stonic" } },
  });
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
  assert.notEqual(result.messageMeta?.outboundTrace?.finalReplySource, "LEGACY");
});

test("live workflow set includes booking and greeting", () => {
  assert.equal(isLiveWorkflowType("booking_request"), true);
  assert.equal(isLiveWorkflowType("greeting"), true);
  assert.equal(isLiveWorkflowType("unknown_clarification"), true);
});

test("non-allowlisted business still routes to sole Brain V2 authority", () => {
  enableV2LiveForSyntheticBusiness();
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = OTHER_BUSINESS;
  assert.equal(evaluateInboundBrainRoute({ businessId: BUSINESS_ID }), "v2_live");
});

test("buffer wrapper returns v2 live result when enabled", async () => {
  enableV2LiveForSyntheticBusiness();
  const result = await tryBrainV2LiveBeforeLegacy({
    traceId: "buffer-live",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.legacyBypassed, true);
});

test("booking executor validates payload without brain decisions", async () => {
  const blocked = await executeCreateBooking({
    payload: { itemId: "", durationDays: 3 },
    executionContext: { businessId: BUSINESS_ID, traceId: "exec-test" },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "MISSING_ITEM_ID");
});

test("booking executor preserves ITEM_ALREADY_BOOKED from inventory", async () => {
  const fake = createFakeBookingDb();
  seedActiveCorollaBooking(fake);

  const result = await executeCreateBooking({
    payload: {
      itemId: "corolla-1",
      itemName: "Toyota Corolla",
      durationDays: 3,
    },
    executionContext: {
      businessId: BUSINESS_ID,
      traceId: "item-already-booked-executor",
      dbOverride: fake.db,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ITEM_ALREADY_BOOKED");
  assert.equal(result.error, "ITEM_ALREADY_BOOKED");
  assert.equal(result.booking, null);
  assert.equal(result.itemName, "Toyota Corolla");
});

test("ITEM_ALREADY_BOOKED returns unavailable reply and skips owner notification", async () => {
  const fake = createFakeBookingDb();
  seedActiveCorollaBooking(fake);

  const result = await routeAndExecuteLiveActionPlan(
    bookingRequestPlan(),
    { bookingExecute: true, ownerExecute: true, dmExecute: false },
    {
      businessId: BUSINESS_ID,
      traceId: "item-already-booked-router",
      dbOverride: fake.db,
      db: fake.db,
    }
  );

  assert.equal(result.sideEffectResults.CREATE_BOOKING.ok, false);
  assert.equal(result.sideEffectResults.CREATE_BOOKING.code, "ITEM_ALREADY_BOOKED");
  assert.equal(result.sideEffectResults.NOTIFY_OWNER, undefined);
  assert.equal(result.bookingCreated, null);
  assert.equal(result.skipRemainingActions, true);
  assert.match(result.reply, /Toyota Corolla is waqt available nahi hai/i);
  assert.doesNotMatch(result.reply, /reply nahi bhej pa rahi/i);
});

test("unexpected live booking failure still uses safe apology", async () => {
  enableV2LiveForSyntheticBusiness();
  process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE = "true";
  process.env.EMILY_BRAIN_V2_OWNER_EXECUTE = "true";
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const throwingDb = {
    collection(name) {
      return createFakeBookingDb().db.collection(name);
    },
    async runTransaction() {
      throw new Error("DB_DOWN");
    },
  };

  const result = await runBrainV2LivePipeline({
    traceId: "unexpected-booking-failure",
    businessId: BUSINESS_ID,
    message: "Toyota Corolla 3 din k lye book krni hai",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    executionContext: { dbOverride: throwingDb, db: throwingDb },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "booking_request" },
      actionPlan: bookingRequestPlan(),
      trace: { test: true },
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "error_apology");
  assert.equal(
    result.reply,
    "Sorry, main abhi reply nahi bhej pa rahi. Thori der baad dobara try karein please."
  );
});

test("successful booking still produces real booking for owner notification dependency", async () => {
  const fake = createFakeBookingDb();

  const result = await routeAndExecuteLiveActionPlan(
    {
      ...bookingRequestPlan({
        itemId: "civic-1",
        itemName: "Honda Civic",
        durationDays: 1,
      }),
      actions: [
        {
          type: "REPLY",
          payload: { text: "Theek hai, mai check kr k btata hun." },
        },
        {
          type: "CREATE_BOOKING",
          payload: {
            execute: true,
            itemId: "civic-1",
            itemName: "Honda Civic",
            durationDays: 1,
          },
        },
        {
          type: "NOTIFY_OWNER",
          payload: { execute: false },
        },
      ],
    },
    { bookingExecute: true, ownerExecute: true, dmExecute: false },
    {
      businessId: BUSINESS_ID,
      traceId: "successful-booking-router",
      dbOverride: fake.db,
      db: fake.db,
    }
  );

  assert.equal(result.sideEffectResults.CREATE_BOOKING.ok, true);
  assert.ok(result.bookingCreated?.id);
  assert.equal(result.bookingCreated.itemName, "Honda Civic");
  assert.equal(result.sideEffectResults.NOTIFY_OWNER, undefined);
  assert.equal(result.skipRemainingActions, false);
});

test("owner executor blocked without booking context", async () => {
  const out = await executeOwnerNotification({
    payload: {},
    booking: {},
    executionContext: { businessId: BUSINESS_ID, traceId: "owner-exec" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "MISSING_BOOKING_ID");
});

test("pipeline source routes all unowned turns through V2 without processMessage", () => {
  const source = executeWhatsAppAiPipeline.toString();
  assert.ok(source.includes("handledByBrainV2Live"));
  assert.ok(source.includes("v2LiveEligible"));
  assert.doesNotMatch(source, /processMessageFn|processMessage\s*\(/);
  assert.ok(source.includes("participantName: normalizedParticipantName"));
  assert.ok(source.includes("sourceParticipantDisplayName: normalizedParticipantDisplayName"));
  assert.ok(source.includes("sourceParticipantKey: normalizedSourceParticipantKey"));
  assert.ok(source.includes("sourceMessageIndex: normalizedSourceMessageIndex"));
});
