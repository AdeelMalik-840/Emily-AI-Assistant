import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { handleCustomerBusinessPaInbound } from "../src/services/customerBusinessPaAgentService.js";
import { tryHandleAvailabilityCustomerCloudInbound } from "../src/services/availabilityCustomerConfirmService.js";
import { tryHandlePaMissingInfoOwnerAnswer } from "../src/services/paMissingInfoOwnerAnswerService.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { resolveAvailabilityAssistFollowUpDecision } from "../src/brain/availability/decideAvailabilityAssistFollowUp.js";
import {
  routeAndExecuteLiveActionPlan,
} from "../src/brain/live/actionRouter.js";

const BUSINESS_ID = "issue1-integrated-business";
const CUSTOMER = "923001111111";
const OWNER = "+923331234567";
const COROLLA_ID = "toyota-corolla";
const CIVIC_ID = "honda-civic";
const STONIC_ID = "kia-stonic";
const YARIS_ID = "toyota-yaris";
const MESSAGE = "Honda Civic 5 din k lye chyh";
const NOW = Date.parse("2026-08-06T09:00:00.000Z");

const CATALOG = [
  { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
  { id: YARIS_ID, name: "Toyota Yaris", displayLabel: "Toyota Yaris" },
];

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  data() {
    const value = this.store.docs.get(this.key);
    return value ? structuredClone(value) : undefined;
  }
}

class FakeDocRef {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
    this.id = String(parts.at(-1));
  }
  get key() {
    return this.parts.join("/");
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prior = this.store.docs.get(this.key) || {};
    this.store.docs.set(
      this.key,
      options.merge ? { ...prior, ...structuredClone(data) } : structuredClone(data)
    );
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) throw new Error("MISSING_DOC");
    const prior = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prior, ...structuredClone(data) });
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.parts, name]);
  }
}

class FakeCollectionRef {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.parts, String(id)]);
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    return { docs: [], empty: true };
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
}

function admitted(text, messageId) {
  return {
    turn: {
      turnId: messageId,
      businessId: BUSINESS_ID,
      channelId: "whatsapp_cloud",
      chatKey: CUSTOMER,
      participantKey: CUSTOMER,
      text,
      normalizedAt: new Date(NOW).toISOString(),
    },
    idempotencyKey: `${messageId}::canonical`,
    admissionReason: "test",
  };
}

function makeTurnInput(text, messageId, memorySnapshot) {
  return buildTurnContextInput({
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: BUSINESS_ID,
    chatId: CUSTOMER,
    participantKey: CUSTOMER,
    sessionKey: `${BUSINESS_ID}::${CUSTOMER}`,
    messageText: text,
    catalogItems: CATALOG,
    memorySnapshot,
    sourceMessageId: messageId,
    sourceRowKey: messageId,
    guaranteeKey: `${CUSTOMER}::${messageId}`,
    traceId: `trace-${messageId}`,
  });
}

test("Issue 1 integrated: stale Corolla focus releases Civic unavailable flow and selected alternative alone gets AVR", async () => {
  const fakeDb = new FakeDb();
  await fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER,
    businessProfile: { ownerNotificationPhone: OWNER },
  });

  const waitingConfirmResult = await tryHandleAvailabilityCustomerCloudInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER,
    messageText: MESSAGE,
    messageId: "turn-1",
    availabilityConfirmExecute: true,
    sendWhatsAppMessageFn: async () => {
      assert.fail("waiting-confirm must not send");
    },
  });
  const ownerAnswerResult = await tryHandlePaMissingInfoOwnerAnswer({
    db: fakeDb,
    businessId: BUSINESS_ID,
    senderPhone: CUSTOMER,
    messageText: MESSAGE,
    messageId: "turn-1",
    missingInfoEnabled: true,
    ownerAnswerEnabled: true,
    __resolvePaMissingInfoOwnerTargetFn: async () => OWNER,
    sendWhatsAppMessageFn: async () => {
      assert.fail("owner-answer must not send");
    },
  });
  assert.equal(waitingConfirmResult, null);
  assert.equal(ownerAnswerResult, null);

  const forbiddenPaCalls = {
    factResolution: 0,
    composition: 0,
    mutation: 0,
    missingInfo: 0,
  };
  const pa = await handleCustomerBusinessPaInbound({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER,
    messageText: MESSAGE,
    messageId: "turn-1",
    preResolvedBookingFacts: {
      ok: true,
      reason: "MATCHED_TRUSTED_FOCUS",
      facts: {
        booking: {
          id: "booking-corolla",
          itemId: COROLLA_ID,
          itemLabel: "Toyota Corolla",
          durationDays: 7,
          status: "approved",
        },
        pendingAvailabilityRequests: [],
      },
    },
    __tryHandlePaMissingInfoCustomerClarificationFn: async () => null,
    __decideCustomerTurnFn: async ({ messageText, activeBooking }) => {
      assert.equal(messageText, MESSAGE);
      assert.equal(activeBooking.itemId, COROLLA_ID);
      return {
        ok: true,
        source: "openai",
        decision: {
          factKind: "booking_fact",
          capability: "availability_request",
          action: "reply",
          mutationIntent: "none",
          pendingAvailabilitySelectionIndex: null,
        },
      };
    },
    __resolvePostConfirmRequestedFactFn: () => {
      forbiddenPaCalls.factResolution += 1;
    },
    __composePostConfirmInformationalCustomerReplyFn: async () => {
      forbiddenPaCalls.composition += 1;
    },
    __executePostConfirmBookingMutationFn: async () => {
      forbiddenPaCalls.mutation += 1;
    },
    __executePostConfirmPaMissingInfoOwnerCheckFn: async () => {
      forbiddenPaCalls.missingInfo += 1;
    },
  });
  assert.equal(pa.ownershipReleased, true);
  assert.equal(pa.releaseReason, "FRESH_AVAILABILITY_REQUEST");
  assert.equal(pa.semanticDecisionCount, 1);
  assert.equal(pa.composeCalls, 0);
  assert.deepEqual(forbiddenPaCalls, {
    factResolution: 0,
    composition: 0,
    mutation: 0,
    missingInfo: 0,
  });

  const memory = {
    lastItem: { id: COROLLA_ID, name: "Toyota Corolla" },
    durationDays: 7,
  };
  const turn1Input = makeTurnInput(MESSAGE, "turn-1", memory);
  assert.equal(turn1Input.authoritativeItem.id, CIVIC_ID);
  assert.equal(turn1Input.duration, 5);

  const bookingLookups = [];
  const requestedWindows = [];
  const getBookingsForItemFn = async (_businessId, itemId) => {
    bookingLookups.push(itemId);
    if (itemId === CIVIC_ID || itemId === COROLLA_ID) {
      return [{
        id: "civic-conflict",
        itemId,
        status: "approved",
        startAt: new Date(NOW),
        endAt: new Date(NOW + 10 * 24 * 60 * 60 * 1000),
      }];
    }
    if (itemId === YARIS_ID) {
      return [{
        id: "yaris-conflict",
        itemId: YARIS_ID,
        status: "approved",
        startAt: new Date(NOW),
        endAt: new Date(NOW + 10 * 24 * 60 * 60 * 1000),
      }];
    }
    return [];
  };
  const aiReply = "Honda Civic 5 din ke liye available nahi hai. Kia Stonic available alternative hai.";
  let unavailableComposerCalls = 0;
  const canonical1 = await resolveBusinessTurnContext({
    traceId: "trace-turn-1",
    businessId: BUSINESS_ID,
    rawMessage: MESSAGE,
    turnContextInput: turn1Input,
    turnContext: { memorySnapshot: memory },
    catalogItems: CATALOG,
    admittedTurn: admitted(MESSAGE, "turn-1"),
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      availabilityOwnerNotifyExecute: true,
      availabilityCustomerDmExecute: false,
      dmExecute: false,
    },
    nowMs: NOW,
    getBusinessProfileFn: async () => ({
      ownerNotificationPhone: OWNER,
      businessProfile: { ownerNotificationPhone: OWNER },
    }),
    getBookingsForItemFn: async (...args) => {
      const result = await getBookingsForItemFn(...args);
      return result;
    },
    __unavailableReplyChatCreate: async ({ messages }) => {
      unavailableComposerCalls += 1;
      assert.match(JSON.stringify(messages), /Honda Civic/);
      assert.match(JSON.stringify(messages), /Kia Stonic/);
      return {
        choices: [{ message: { content: JSON.stringify({
          reply: aiReply,
          replySemantics: {
            claims: ["resource_unavailable"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }) } }],
      };
    },
  });
  const civicAvailability = canonical1.verified.availability;
  assert.equal(civicAvailability.status, "unavailable");
  assert.equal(civicAvailability.isAvailable, false);
  assert.equal(civicAvailability.windowApplied, true);
  assert.equal(canonical1.turn.durationDays, 5);
  assert.equal(unavailableComposerCalls, 1);
  assert.deepEqual(
    civicAvailability.verifiedAlternatives.map((row) => row.itemId),
    [STONIC_ID]
  );

  const plan1 = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted(MESSAGE, "turn-1"),
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
      itemSource: "explicit",
      askedField: "availability",
      durationDays: 5,
      intentsRanked: ["availability_check"],
      signals: { availabilityAsk: true },
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical1 },
  });
  assert.equal(plan1.replyDraft, aiReply);
  assert.equal(plan1.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
  assert.match(plan1.replyDraft, /Honda Civic/i);
  assert.match(plan1.replyDraft, /Kia Stonic/i);
  assert.doesNotMatch(plan1.replyDraft, /Toyota Corolla|7\s*din/i);

  const civicSideEffects = await routeAndExecuteLiveActionPlan(plan1, {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: true,
    availabilityCustomerDmExecute: false,
    dmExecute: false,
  }, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    participantKey: CUSTOMER,
    participantPhoneForDm: CUSTOMER,
    messageId: "turn-1",
  });
  assert.equal(civicSideEffects.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED, undefined);
  assert.equal(civicSideEffects.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION, undefined);

  const offered = plan1.persistenceIntent.lastAvailabilityAssist;
  const selected = resolveAvailabilityAssistFollowUpDecision({
    lastAvailabilityAssist: offered,
    brainDecision: {
      decision: "select_alternative_item",
      confidence: 0.99,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    understanding: { resolvedItemId: STONIC_ID },
  });
  assert.equal(selected.selectedItemId, STONIC_ID);

  const canonical2 = {
    ...canonical1,
    lastAvailabilityAssist: offered,
    availabilityAssistFollowUp: selected,
    unavailableCustomerReply: null,
    resolvedItem: {
      status: "resolved",
      id: STONIC_ID,
      name: "Kia Stonic",
      displayLabel: "Kia Stonic",
      source: "explicit",
      confidence: 1,
      candidates: [],
    },
    turn: {
      ...canonical1.turn,
      durationDays: 5,
      sourceMessageId: "turn-2",
      sourceRowKey: "turn-2",
      guaranteeKey: `${CUSTOMER}::turn-2`,
      sourceTurnKey: `${CUSTOMER}::turn-2`,
    },
    verified: {
      ...canonical1.verified,
      availability: {
        status: "available",
        isAvailable: true,
        reason: "no_blocking_bookings",
        windowApplied: true,
        requestedStartAt: civicAvailability.requestedStartAt,
        requestedEndAt: civicAvailability.requestedEndAt,
        verifiedAlternatives: civicAvailability.verifiedAlternatives,
      },
    },
  };
  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Kia Stonic", "turn-2"),
    understanding: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      itemSource: "explicit",
      durationDays: 5,
      signals: {},
    },
    catalogItems: CATALOG,
    businessContext: {
      __availabilityAssistFollowUpDecision: selected,
      resolvedBusinessTurnContext: canonical2,
    },
  });
  const ownerAction = plan2.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload.itemId, STONIC_ID);
  assert.equal(ownerAction.payload.durationDays, 5);
  requestedWindows.push({
    start: ownerAction.payload.requestedStartAt,
    end: ownerAction.payload.requestedEndAt,
  });

  const ownerSends = [];
  const executed = await routeAndExecuteLiveActionPlan(plan2, {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: true,
    availabilityOwnerNotifyExecute: true,
    availabilityCustomerDmExecute: false,
    dmExecute: false,
  }, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    traceId: "trace-turn-2",
    sessionKey: `${BUSINESS_ID}::${CUSTOMER}`,
    participantKey: CUSTOMER,
    participantPhoneForDm: CUSTOMER,
    messageId: "turn-2",
    sourceRowKey: "turn-2",
    guaranteeKey: `${CUSTOMER}::turn-2`,
    chatId: CUSTOMER,
    chatType: "dm",
    sendWhatsAppMessageFn: async (...args) => {
      ownerSends.push(args);
      return { ok: true, providerMessageId: "owner-provider-1" };
    },
  });
  const created = executed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED;
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.request.itemId, STONIC_ID);
  assert.equal(created.request.durationDays ?? created.request.requestedDuration, 5);
  assert.equal(executed.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.sent, true);
  assert.equal(ownerSends.length, 1);
  assert.match(ownerSends[0][1], /Kia Stonic/);
  assert.doesNotMatch(ownerSends[0][1], /Toyota Corolla|Honda Civic/);

  const avrs = [...fakeDb.docs.entries()]
    .filter(([key]) => key.includes("/availabilityRequests/"))
    .map(([, value]) => value);
  assert.equal(avrs.length, 1);
  assert.equal(avrs[0].itemId, STONIC_ID);
  assert.equal(ownerSends.length, 1);
  assert.equal(requestedWindows.length, 1);
  assert.equal(requestedWindows[0].start, civicAvailability.requestedStartAt);
  assert.equal(requestedWindows[0].end, civicAvailability.requestedEndAt);
  assert.ok(bookingLookups.includes(CIVIC_ID));
  assert.ok(bookingLookups.includes(STONIC_ID));
  assert.ok(bookingLookups.includes(YARIS_ID));
});
