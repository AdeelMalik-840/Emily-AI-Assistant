import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";

const TMP_LEDGER = path.join(
  os.tmpdir(),
  `pr1b-replay-ledger-${process.pid}-${Date.now()}.json`
);
const TMP_REGISTRY = path.join(
  os.tmpdir(),
  `pr1b-replay-outbound-${process.pid}-${Date.now()}.json`
);
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = TMP_LEDGER;
process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH = TMP_REGISTRY;

import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  __clearInboundTurnLedgerForTests,
  __reloadInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerOutboundLockedForGuarantee,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
} from "../src/services/inboundTurnLedger.js";
import {
  __clearPlaywrightOutboundRegistryForTests,
  __reloadPlaywrightOutboundRegistryForTests,
  __setPlaywrightOutboundRegistryPathForTests,
  isRegisteredPlaywrightOutboundEcho,
} from "../src/services/playwrightOutboundRegistry.js";
import {
  __finalizeAdmittedInboundTurnLedgerForTests,
} from "../src/services/whatsappInboundBuffer.js";
import { tryRecoverOutboundLockedInboundTurn } from "../src/services/outboundLockedRecovery.js";
import { sendViaPlaywright } from "../src/services/adapters/playwrightAdapter.js";
import { buildLogicalAvailabilityRequestKey } from "../src/services/availabilityRequestService.js";
import { buildStableMessageKey } from "../src/services/playwrightListener/listener.js";

const BUSINESS_ID = "biz-pr1b-replay-001";
const CHAT_KEY = "car rental queries";
const CHAT_ID = "car-rental-queries";
const PARTICIPANT_KEY = "cust-pr1b-replay";
const COROLLA_ID = "toyota_corolla_pr1b_replay";
const COROLLA_LABEL = "Toyota Corolla";
const OWNER_PHONE = "+923001112233";

function enableV2ReplayEnv() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = "true";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE = "true";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE = "false";
  process.env.PLAYWRIGHT_NO_SEND = "false";
}

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  data() {
    const v = this.store.docs.get(this.key);
    return v ? structuredClone(v) : undefined;
  }
}

class FakeDocRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  get key() {
    return this.pathParts.join("/");
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(
      this.key,
      options?.merge ? { ...prev, ...structuredClone(data) } : structuredClone(data)
    );
  }
  async update(data) {
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.pathParts, name]);
  }
}

class FakeCollectionRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
    this.filters = [];
    this.limitCount = null;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
  }
  where(field, op, value) {
    const next = new FakeCollectionRef(this.store, this.pathParts);
    next.filters = [...this.filters, { field, op, value }];
    next.limitCount = this.limitCount;
    return next;
  }
  limit(n) {
    const next = new FakeCollectionRef(this.store, this.pathParts);
    next.filters = [...this.filters];
    next.limitCount = n;
    return next;
  }
  async get() {
    const prefix = this.pathParts.join("/") + "/";
    let docs = [...this.store.docs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        id: key.slice(prefix.length).split("/")[0],
        ref: new FakeDocRef(this.store, key.split("/")),
        data: () => structuredClone(value),
      }));
    for (const f of this.filters) {
      docs = docs.filter((doc) => {
        if (f.op !== "==") return false;
        return doc.data()?.[f.field] === f.value;
      });
    }
    if (Number.isFinite(this.limitCount)) docs = docs.slice(0, this.limitCount);
    return { docs, empty: docs.length === 0 };
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
  doc(...parts) {
    return new FakeDocRef(this, parts.flatMap((p) => String(p).split("/")).filter(Boolean));
  }
  async runTransaction(fn) {
    return fn({
      get: (refOrQuery) => refOrQuery.get(),
      set: (ref, data, options) => ref.set(data, options),
      create: (ref, data) => ref.set(data),
      update: (ref, data) => ref.update(data),
    });
  }
}

function availabilityRequestPath(requestId) {
  return `businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`;
}

async function seedBusiness(db) {
  await db.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: { ownerNotificationPhone: OWNER_PHONE },
  });
}

function seedWaitingConfirmAvr(db, id, overrides = {}) {
  db.docs.set(availabilityRequestPath(id), {
    requestId: id,
    businessId: BUSINESS_ID,
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationDays: 3,
    requestedDuration: 3,
    customerParticipantId: PARTICIPANT_KEY,
    sourceChatId: CHAT_ID,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    ownerNotificationStatus: "sent",
    customerDmNotificationStatus: "sent",
    logicalRequestKey: buildLogicalAvailabilityRequestKey({
      businessId: BUSINESS_ID,
      customerParticipantId: PARTICIPANT_KEY,
      sourceChatId: CHAT_ID,
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 3,
      requestedDates: [],
    }),
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    confirmExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...structuredClone(overrides),
  });
}

function countAvailabilityRequests(db) {
  let count = 0;
  for (const key of db.docs.keys()) {
    if (key.startsWith(`businesses/${BUSINESS_ID}/availabilityRequests/`)) count += 1;
  }
  return count;
}

function pr1bOwnerCheckPlan({
  sourceTurnKey,
  sourceMessageId,
  requestedDuration = 3,
  requestedDates = [],
} = {}) {
  return {
    planId: `plan-${sourceMessageId}`,
    workflowType: "availability_inquiry",
    replyDraft: "",
    postExecuteCustomerReply: "owner_check_result",
    actions: [
      {
        type: "REPLY",
        payload: {
          text: "",
          field: "availability",
          source: "canonical_owner_check_post_execute",
          awaitPostExecuteReply: true,
          execute: false,
        },
      },
      {
        type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
        payload: {
          businessId: BUSINESS_ID,
          itemId: COROLLA_ID,
          itemLabel: COROLLA_LABEL,
          durationDays: requestedDuration,
          requestedDuration,
          requestedDates,
          requestedStartAt: null,
          requestedEndAt: null,
          canonicalAvailability: { status: "available", isAvailable: true },
          canonicalPriceQuote: null,
          participant: { key: PARTICIPANT_KEY, identity: "stable" },
          customerParticipantId: PARTICIPANT_KEY,
          sourceChatId: CHAT_ID,
          sourceChatType: "group",
          sourceMessageId,
          sourceRowKey: `row-${sourceMessageId}`,
          guaranteeKey: sourceTurnKey,
          sourceTurnKey,
          sourceIdentity: {
            participantKey: PARTICIPANT_KEY,
            participantIdentity: "stable",
            chatId: CHAT_ID,
            chatType: "group",
            sourceMessageId,
            sourceRowKey: `row-${sourceMessageId}`,
            guaranteeKey: sourceTurnKey,
            sourceTurnKey,
          },
          ownerTarget: null,
          customerDmTarget: null,
          execute: true,
        },
      },
    ],
  };
}

function makeInboundRow({ messageId, text = "Corolla" }) {
  return {
    sender: "user",
    participantKey: PARTICIPANT_KEY,
    text,
    prePlainText: "[11:23 AM] Adeel: ",
    id: { _serialized: messageId },
    __position: 1,
    __rowKey: `real:${messageId}#1`,
    sourceMessageIndex: 1,
  };
}

// Stage 4 (generation-simplification): the Group holding reply now routes
// through the same shared composer Cloud DM uses
// (composeCloudCanonicalCustomerReply, kind=owner_check_holding), not a
// separate lane/schema -- this stub's shape matches that composer's real
// response contract (customerReply + replySemantics) instead of the old
// lane's retired action/shouldReply schema.
function makeGroupBrainStub(replyText, callLog) {
  return async (args) => {
    callLog.push(args);
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: replyText,
              // owner_check_holding requires customerInputRequested=false with
              // requestedInput=null on the FIRST completion to satisfy the
              // structured no-input contract (RESPONSE_CONTRACT_NO_INPUT_NULLABILITY_GAP
              // fix), availabilityCheckStarted=true (the request IS already
              // being progressed), and resource_availability_unconfirmed in
              // claims (positive objective-fidelity requirement) -- a real
              // compliant model response always includes all of these.
              customerInputRequested: false,
              requestedInput: null,
              availabilityCheckStarted: true,
              responseAct: "INFORM_AVAILABILITY_CHECK_STARTED",
              utteranceFunction: "inform_status",
              surfaceContract: {
                personaActor: "EMILY",
                agencyActor: "EMILY",
                firstPersonSelfReference: "feminine",
                timingReference: "none",
              },
              replySemantics: {
                claims: ["resource_availability_unconfirmed"],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    };
  };
}

async function executeSuccessfulPlaywrightSend({
  guaranteeKey,
  reply,
  messageMeta,
  sendCalls,
  sourceInboundMessageId,
}) {
  markInboundTurnLedgerOutboundLockedForGuarantee({
    guaranteeKey,
    textPreview: "Corolla",
    replyPreview: reply,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: CHAT_KEY,
    replyHash: `reply-hash-${guaranteeKey}`,
  });
  const result = await sendViaPlaywright({
    reply,
    messageMeta,
    context: {
      groupNameResolved: CHAT_KEY,
      sessionKey: `${BUSINESS_ID}::${CHAT_ID}::participant::${PARTICIPANT_KEY}`,
      messageHash: `msg-hash-${guaranteeKey}`,
      dedupeWindowMs: 8000,
      lastPlaywrightTextSends: new Map(),
      guaranteeKey,
      sourceInboundMessageId,
      outboundLifecycle: { traceId: `trace-${guaranteeKey}` },
      __testSendPlaywrightGroupText: async () => {
        sendCalls.push({ guaranteeKey, reply });
        return true;
      },
    },
  });
  assert.equal(result.ok, true);
  const finalized = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: true,
    intentionalSilent: false,
    textPreview: "Corolla",
  });
  assert.equal(finalized, "done");
}

async function runPostExecutePipeline({
  db,
  stableId,
  guaranteeKey,
  messageText = "Corolla",
  brainReply = "Theek hai, request note kar li hai.",
  requestedDuration = 3,
  requestedDates = [],
  getBookingsForItemFn = async () => [],
} = {}) {
  const sourceMessageId = stableId.replace(/^wa::/, "");
  const brainCalls = [];
  const ownerNotifyCalls = [];
  const result = await runBrainV2LivePipeline({
    traceId: `trace-${stableId}`,
    businessId: BUSINESS_ID,
    message: messageText,
    messageId: sourceMessageId,
    channel: "whatsapp_web",
    chatType: "group",
    chatId: CHAT_ID,
    sessionKey: `${BUSINESS_ID}::${CHAT_ID}::participant::${PARTICIPANT_KEY}`,
    participantKey: PARTICIPANT_KEY,
    participantName: "Adeel",
    playwrightChatKey: CHAT_ID,
    isGroupInbound: true,
    playwrightWebInbound: true,
    groupName: CHAT_KEY,
    conversationHistory: "Customer: Corolla\nEmily: Detail share karein",
    catalogItems: [
      { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL },
      { id: "civic-1", name: "Honda Civic", displayLabel: "Honda Civic" },
    ],
    executionContext: {
      db,
      dbOverride: db,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      traceId: `trace-${stableId}`,
      chatId: CHAT_ID,
      chatType: "group",
      participantKey: PARTICIPANT_KEY,
      messageId: sourceMessageId,
      guaranteeKey,
      sendWhatsAppMessageFn: async (...args) => {
        ownerNotifyCalls.push(args);
        return { ok: true, providerMessageId: `owner-${sourceMessageId}` };
      },
      getBookingsForItemFn,
    },
    // Top-level, not nested under executionContext -- this is the same
    // __cloudComposeChatCreate hook composeCloudCanonicalCustomerReply
    // already reads for Cloud DM's owner_check_holding path (Stage 4 routes
    // Group through the identical composer call).
    __cloudComposeChatCreate: makeGroupBrainStub(brainReply, brainCalls),
    getBookingsForItemFn,
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "availability_inquiry", reason: "test_pr1b" },
      actionPlan: pr1bOwnerCheckPlan({
        sourceTurnKey: guaranteeKey,
        sourceMessageId,
        requestedDuration,
        requestedDates,
      }),
      understanding: {
        signals: { availabilityAsk: true },
        resolvedItemId: COROLLA_ID,
        resolvedItemLabel: COROLLA_LABEL,
        durationDays: requestedDuration,
      },
      trace: { test: true },
    }),
  });

  return { result, brainCalls, ownerNotifyCalls };
}

test.beforeEach(() => {
  enableV2ReplayEnv();
  __setInboundTurnLedgerPathForTests(TMP_LEDGER);
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  __setPlaywrightOutboundRegistryPathForTests(TMP_REGISTRY);
  __clearPlaywrightOutboundRegistryForTests();
  __reloadPlaywrightOutboundRegistryForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__playwrightTextSentForGuarantee = new Map();
});

test.after(() => {
  for (const file of [TMP_LEDGER, TMP_REGISTRY]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
});

test("1: exact replay before execution blocks duplicate action and duplicate send", async () => {
  const db = new FakeDb();
  await seedBusiness(db);
  const stableId = "wa::pr1b-replay-001";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;

  assert.deepEqual(
    resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId, textPreview: "Corolla" }),
    { blocked: false }
  );
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });
  const secondAdmission = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: "Corolla",
  });
  assert.equal(secondAdmission.blocked, true);
  assert.equal(secondAdmission.reason, "recent_processing_duplicate");

  const { result, brainCalls, ownerNotifyCalls } = await runPostExecutePipeline({
    db,
    stableId,
    guaranteeKey,
    brainReply: "Corolla ke liye request note kar li hai.",
  });
  const sendCalls = [];
  await executeSuccessfulPlaywrightSend({
    guaranteeKey,
    reply: result.reply,
    messageMeta: result.messageMeta,
    sendCalls,
    sourceInboundMessageId: stableId,
  });

  assert.equal(countAvailabilityRequests(db), 1);
  assert.equal(ownerNotifyCalls.length, 1);
  assert.equal(brainCalls.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), true);
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.replySent, true);
});

test("2: reply generated but send not started — recovery resumes exact reply once", async () => {
  const db = new FakeDb();
  await seedBusiness(db);
  const stableId = "wa::pr1b-replay-002";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });

  const { result, brainCalls, ownerNotifyCalls } = await runPostExecutePipeline({
    db,
    stableId,
    guaranteeKey,
    brainReply: "Corolla ki request aagay bhej di hai.",
  });
  markInboundTurnLedgerOutboundLockedForGuarantee({
    guaranteeKey,
    textPreview: "Corolla",
    replyPreview: result.reply,
    finalReplyText: result.reply,
    finalReplySource: result.messageMeta?.outboundTrace?.finalReplySource,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: CHAT_KEY,
    replyHash: `reply-hash-${guaranteeKey}`,
  });

  __reloadInboundTurnLedgerForTests();

  const blocked = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: "Corolla",
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "outbound_locked");
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), false);

  const sendCalls = [];
  const recovery = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(text);
      return true;
    },
  });

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.sent, true);
  assert.equal(recovery.replyText, result.reply);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0], result.reply);
  assert.equal(ownerNotifyCalls.length, 1);
  assert.equal(brainCalls.length, 1);
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.state, "done");
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), true);
});

test("3: outbound registered with uncertain post-send completion does not duplicate send or brain generation", async () => {
  const db = new FakeDb();
  await seedBusiness(db);
  const stableId = "wa::pr1b-replay-003";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });

  const { result, brainCalls, ownerNotifyCalls } = await runPostExecutePipeline({
    db,
    stableId,
    guaranteeKey,
    brainReply: "Corolla ke liye detail note kar li hai.",
  });
  const sendCalls = [];
  markInboundTurnLedgerOutboundLockedForGuarantee({
    guaranteeKey,
    textPreview: "Corolla",
    replyPreview: result.reply,
    finalReplyText: result.reply,
    finalReplySource: result.messageMeta?.outboundTrace?.finalReplySource,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: CHAT_KEY,
    replyHash: `reply-hash-${guaranteeKey}`,
  });
  const sendResult = await sendViaPlaywright({
    reply: result.reply,
    messageMeta: result.messageMeta,
    context: {
      groupNameResolved: CHAT_KEY,
      sessionKey: `${BUSINESS_ID}::${CHAT_ID}::participant::${PARTICIPANT_KEY}`,
      messageHash: `msg-hash-${guaranteeKey}`,
      dedupeWindowMs: 8000,
      lastPlaywrightTextSends: new Map(),
      guaranteeKey,
      sourceInboundMessageId: stableId,
      outboundLifecycle: { traceId: `trace-${stableId}` },
      __testSendPlaywrightGroupText: async () => {
        sendCalls.push({ guaranteeKey, reply: result.reply });
        return true;
      },
    },
  });
  assert.equal(sendResult.ok, true);

  __reloadInboundTurnLedgerForTests();
  __reloadPlaywrightOutboundRegistryForTests();
  const blocked = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: "Corolla",
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "outbound_locked");
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), true);

  const recoverySends = [];
  const recovery = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      recoverySends.push(text);
      return true;
    },
  });
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.action, "complete_ledger");
  assert.equal(recovery.sent, false);
  assert.equal(recoverySends.length, 0);
  assert.equal(ownerNotifyCalls.length, 1);
  assert.equal(brainCalls.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.state, "done");
});

test("4: send succeeded before ledger done; restart + rescan still does not duplicate reply", async () => {
  const db = new FakeDb();
  await seedBusiness(db);
  const stableId = "wa::pr1b-replay-004";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });

  const { result, brainCalls, ownerNotifyCalls } = await runPostExecutePipeline({
    db,
    stableId,
    guaranteeKey,
    brainReply: "Corolla ke liye request bhej di hai.",
  });
  const sendCalls = [];
  markInboundTurnLedgerOutboundLockedForGuarantee({
    guaranteeKey,
    textPreview: "Corolla",
    replyPreview: result.reply,
    finalReplyText: result.reply,
    finalReplySource: result.messageMeta?.outboundTrace?.finalReplySource,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: CHAT_KEY,
    replyHash: `reply-hash-${guaranteeKey}`,
  });
  const sendResult = await sendViaPlaywright({
    reply: result.reply,
    messageMeta: result.messageMeta,
    context: {
      groupNameResolved: CHAT_KEY,
      sessionKey: `${BUSINESS_ID}::${CHAT_ID}::participant::${PARTICIPANT_KEY}`,
      messageHash: `msg-hash-${guaranteeKey}`,
      dedupeWindowMs: 8000,
      lastPlaywrightTextSends: new Map(),
      guaranteeKey,
      sourceInboundMessageId: stableId,
      outboundLifecycle: { traceId: `trace-${stableId}` },
      __testSendPlaywrightGroupText: async () => {
        sendCalls.push({ guaranteeKey, reply: result.reply });
        return true;
      },
    },
  });
  assert.equal(sendResult.ok, true);

  __reloadInboundTurnLedgerForTests();
  __reloadPlaywrightOutboundRegistryForTests();

  const blocked = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: "Corolla",
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "outbound_locked");
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), true);

  const recoverySends = [];
  const recovery = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      recoverySends.push(text);
      return true;
    },
  });
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.action, "complete_ledger");
  assert.equal(recovery.sent, false);
  assert.equal(recoverySends.length, 0);
  assert.equal(ownerNotifyCalls.length, 1);
  assert.equal(brainCalls.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.state, "done");
});

test("5: already-answered row rescan is blocked before any brain/action work", () => {
  const row = makeInboundRow({ messageId: "wa-row-005", text: "Corolla" });
  const stableId = buildStableMessageKey(row, [row]).id;
  markInboundTurnLedgerDone({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey: `${CHAT_KEY}::${stableId}`,
    replySent: true,
    textPreview: row.text,
  });
  __reloadInboundTurnLedgerForTests();

  const blocked = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: row.text,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "already_answered");
});

test("6: waiting_confirm reuse replay uses one reused AVR, zero owner notifications, one group send, zero cloud DM", async () => {
  const db = new FakeDb();
  await seedBusiness(db);
  seedWaitingConfirmAvr(db, "avr-waiting-confirm-001");
  const stableId = "wa::pr1b-replay-006";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });

  const { result, brainCalls, ownerNotifyCalls } = await runPostExecutePipeline({
    db,
    stableId,
    guaranteeKey,
    brainReply: "Corolla wali pehli request abhi bhi active hai.",
  });
  const sideEffects = result.messageMeta?.actionRouter?.sideEffectResults ?? {};
  assert.equal(
    sideEffects?.OWNER_CHECK_POST_EXECUTE_RESULT?.responseDisposition,
    "waiting_confirm_reused_guidance_allowed"
  );
  assert.equal(sideEffects?.AVAILABILITY_OWNER_CHECK_REQUIRED?.reused, true);
  assert.equal(sideEffects?.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, false);
  assert.equal(ownerNotifyCalls.length, 0);

  const sendCalls = [];
  await executeSuccessfulPlaywrightSend({
    guaranteeKey,
    reply: result.reply,
    messageMeta: result.messageMeta,
    sendCalls,
    sourceInboundMessageId: stableId,
  });

  assert.equal(brainCalls.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(result.sendVia, "PLAYWRIGHT");
  assert.equal(result.dmRecipientPhone, null);
  assert.equal(countAvailabilityRequests(db), 1);
  assert.equal(
    result.messageMeta?.outboundTrace?.finalReplySource,
    "BRAIN_V2_GROUP_POST_EXECUTE"
  );
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT_KEY, result.reply), true);

  const replayBlocked = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT_KEY,
    stableId,
    textPreview: "Corolla",
  });
  assert.equal(replayBlocked.blocked, true);
  assert.equal(replayBlocked.reason, "already_answered");
});
