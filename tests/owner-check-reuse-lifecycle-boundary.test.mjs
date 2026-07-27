/**
 * Owner-check semantic reuse lifecycle boundary + execution-aware reply sync.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  createAvailabilityRequest,
  buildLogicalAvailabilityRequestKey,
  evaluateSemanticAvailabilityReuseEligibility,
  explicitRequestedDatesCompatible,
} from "../src/services/availabilityRequestService.js";
import {
  executeLiveSideEffects,
  routeLiveActionPlan,
  routeAndExecuteLiveActionPlan,
  shouldAllowOwnerCheckDeferralReply,
  isOpenOwnerCheckJourney,
} from "../src/brain/live/actionRouter.js";
import {
  markInboundTurnLedgerDone,
  resolveInboundTurnAdmissionBlock,
} from "../src/services/inboundTurnLedger.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const COROLLA_ID = "toyota_corolla_metallic_grey_0e2cd610";
const COROLLA_LABEL = "Toyota corolla (Metallic Grey)";
const OWNER_PHONE = "+923331234567";

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
    const next =
      options && options.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) throw new Error("MISSING_DOC");
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
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
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

function avrPath(requestId) {
  return `businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`;
}

function seedAvr(fakeDb, requestId, data) {
  fakeDb.docs.set(avrPath(requestId), {
    requestId,
    businessId: BUSINESS_ID,
    ...structuredClone(data),
  });
}

function getAvr(fakeDb, requestId) {
  return fakeDb.docs.get(avrPath(requestId));
}

function basePayload(overrides = {}) {
  const sourceTurnKey = overrides.sourceTurnKey ?? "leads::cust-1::msg-fresh-001";
  return {
    businessId: BUSINESS_ID,
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationDays: 2,
    requestedDuration: 2,
    participant: { key: "cust-1", identity: "stable" },
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    sourceChatType: "group",
    sourceMessageId: "msg-fresh-001",
    sourceRowKey: "row-fresh-001",
    guaranteeKey: sourceTurnKey,
    sourceTurnKey,
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "stable",
      chatId: "leads",
      chatType: "group",
      sourceMessageId: "msg-fresh-001",
      sourceRowKey: "row-fresh-001",
      guaranteeKey: sourceTurnKey,
      sourceTurnKey,
    },
    ...overrides,
  };
}

function logicalKeyFor(payload = {}) {
  return buildLogicalAvailabilityRequestKey({
    businessId: BUSINESS_ID,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    requestedDuration: payload.requestedDuration ?? payload.durationDays ?? 2,
    requestedDates: payload.requestedDates ?? [],
  });
}

async function seedBusiness(fakeDb) {
  await fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: {
      ownerNotificationPhone: OWNER_PHONE,
    },
  });
}

function ownerCheckPlan({ turn = "msg-a" } = {}) {
  const sourceTurnKey = `leads::cust-1::${turn}`;
  return {
    planId: "plan-lifecycle",
    workflowType: "availability_inquiry",
    replyDraft: "corolla 2 din ke liye mai confirm kar leta hun.",
    actions: [
      {
        type: "REPLY",
        payload: {
          text: "corolla 2 din ke liye mai confirm kar leta hun.",
          execute: false,
        },
      },
      {
        type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
        payload: {
          ...basePayload({
            sourceTurnKey,
            guaranteeKey: sourceTurnKey,
            sourceMessageId: turn,
            sourceIdentity: {
              participantKey: "cust-1",
              chatId: "leads",
              chatType: "group",
              sourceMessageId: turn,
              guaranteeKey: sourceTurnKey,
              sourceTurnKey,
            },
          }),
          execute: true,
        },
      },
    ],
  };
}

function assertNoOwnerCheckPromiseWording(reply) {
  const text = String(reply ?? "");
  assert.doesNotMatch(text, /mai confirm kar leta hun/i);
  assert.doesNotMatch(text, /mai check kr k btata hun/i);
  assert.doesNotMatch(text, /Book kar du\?/i);
}

const defaultFlags = {
  bookingExecute: false,
  ownerExecute: false,
  availabilityOwnerCheckExecute: true,
  availabilityOwnerNotifyExecute: true,
  availabilityCustomerDmExecute: false,
  dmExecute: false,
};

test("eligibility: approved+superseded is not semantically reusable", () => {
  const result = evaluateSemanticAvailabilityReuseEligibility({
    status: "approved",
    customerConfirmationStatus: "superseded",
    ownerNotificationStatus: "sent",
  });
  assert.equal(result.reusable, false);
  assert.equal(result.reason, "CONFIRM_SUPERSEDED");
});

test("eligibility: pending is NOT cross-source reusable (no approved freshness window)", () => {
  const result = evaluateSemanticAvailabilityReuseEligibility({
    status: "pending",
    expiresAt: new Date(Date.now() + 6 * 86400000),
  });
  assert.equal(result.reusable, false);
  assert.equal(result.reason, "CROSS_SOURCE_PENDING_NO_APPROVED_FRESHNESS");
});

test("eligibility: approved+waiting_confirm unexpired is reusable", () => {
  const result = evaluateSemanticAvailabilityReuseEligibility({
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
  });
  assert.equal(result.reusable, true);
  assert.equal(result.kind, "waiting_confirm");
});

test("date windows: both empty → compatible", () => {
  assert.equal(explicitRequestedDatesCompatible({}, {}), true);
});

test("date windows: old empty + new explicit → incompatible", () => {
  assert.equal(
    explicitRequestedDatesCompatible({}, { requestedDates: ["2026-08-01"] }),
    false
  );
});

test("date windows: old explicit + new empty → incompatible", () => {
  assert.equal(
    explicitRequestedDatesCompatible({ requestedDates: ["2026-08-01"] }, {}),
    false
  );
});

test("date windows: both differ → incompatible", () => {
  assert.equal(
    explicitRequestedDatesCompatible(
      { requestedDates: ["2026-08-01"] },
      { requestedDates: ["2026-09-01"] }
    ),
    false
  );
});

test("date windows: both match → compatible", () => {
  assert.equal(
    explicitRequestedDatesCompatible(
      { requestedDates: ["2026-08-01", "2026-08-02"] },
      { requestedDates: ["2026-08-02", "2026-08-01"] }
    ),
    true
  );
});

test("A: exact source replay with sent notification — same AVR", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const payload = basePayload({ sourceTurnKey: "leads::cust-1::msg-exact" });
  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  const stored = getAvr(fakeDb, first.requestId);
  stored.ownerNotificationStatus = "sent";
  fakeDb.docs.set(avrPath(first.requestId), stored);

  const second = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.reuseReason, "EXACT_SOURCE_TURN");
  assert.equal(second.lifecycleKind, "exact_source_replay");
});

test("B: exact source replay after failed notification retries same AVR", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const payload = basePayload({ sourceTurnKey: "leads::cust-1::msg-retry" });
  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  const stored = getAvr(fakeDb, first.requestId);
  stored.ownerNotificationStatus = "failed";
  stored.ownerNotificationAttemptCount = 1;
  fakeDb.docs.set(avrPath(first.requestId), stored);

  const plan = ownerCheckPlan({ turn: "msg-retry" });
  const sendCalls = [];
  const result = await executeLiveSideEffects({
    actionPlan: plan,
    routed: routeLiveActionPlan(plan, defaultFlags),
    flags: defaultFlags,
    executionContext: {
      db: fakeDb,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      messageId: "msg-retry",
      guaranteeKey: "leads::cust-1::msg-retry",
      chatId: "leads",
      chatType: "group",
      participantKey: "cust-1",
      sendWhatsAppMessageFn: async (...args) => {
        sendCalls.push(args);
        return { ok: true, providerMessageId: "retry-1" };
      },
    },
  });
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId, first.requestId);
  assert.equal(result.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(result.suppressCustomerReply, false);
});

test("C: different source turn vs pending AVR → fresh AVR (no 7d expiresAt dedupe)", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const key = logicalKeyFor();
  seedAvr(fakeDb, "avr_old_pending", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "pending",
    ownerNotificationStatus: "sent",
    requestedDuration: 2,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: key,
    createdAt: new Date(Date.now() - 6 * 86400000),
    expiresAt: new Date(Date.now() + 1 * 86400000),
  });
  const created = await createAvailabilityRequest({
    db: fakeDb,
    payload: basePayload({ sourceTurnKey: "leads::cust-1::msg-new-pending" }),
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  assert.equal(created.created, true);
  assert.notEqual(created.requestId, "avr_old_pending");
  assert.equal(created.lifecycleKind, "fresh_owner_check");
});

test("E: old approved+superseded ignored — fresh AVR + new notify + deferral", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const key = logicalKeyFor();
  seedAvr(fakeDb, "avr_old_superseded", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "superseded",
    supersededByAvailabilityRequestId: "avr_other",
    ownerNotificationStatus: "sent",
    requestedDuration: 2,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: key,
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });

  const plan = ownerCheckPlan({ turn: "msg-new-corolla" });
  const sendCalls = [];
  const routed = await routeAndExecuteLiveActionPlan(plan, defaultFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-new-corolla",
    guaranteeKey: "leads::cust-1::msg-new-corolla",
    chatId: "leads",
    chatType: "group",
    participantKey: "cust-1",
    isGroupInbound: true,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true, providerMessageId: "fresh-notify" };
    },
  });

  const check = routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED;
  assert.equal(check.created, true);
  assert.notEqual(check.requestId, "avr_old_superseded");
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(routed.customerReplySuppressed, false);
  assert.match(String(routed.reply), /mai confirm kar leta hun/i);
});

test("F/G/H: confirmed / linked / rejected create fresh AVR", async () => {
  for (const [id, patch] of [
    [
      "avr_confirmed",
      { status: "approved", customerConfirmationStatus: "confirmed", ownerNotificationStatus: "sent" },
    ],
    [
      "avr_linked",
      {
        status: "approved",
        customerConfirmationStatus: "waiting_confirm",
        linkedBookingId: "booking-xyz",
        confirmExpiresAt: new Date(Date.now() + 86400000),
        ownerNotificationStatus: "sent",
      },
    ],
    ["avr_rejected", { status: "rejected", ownerNotificationStatus: "sent" }],
  ]) {
    const fakeDb = new FakeDb();
    await seedBusiness(fakeDb);
    seedAvr(fakeDb, id, {
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 2,
      customerParticipantId: "cust-1",
      sourceChatId: "leads",
      logicalRequestKey: logicalKeyFor(),
      ...patch,
    });
    const created = await createAvailabilityRequest({
      db: fakeDb,
      payload: basePayload({ sourceTurnKey: `leads::cust-1::msg-after-${id}` }),
      executionContext: { db: fakeDb, businessId: BUSINESS_ID },
    });
    assert.equal(created.created, true, id);
    assert.notEqual(created.requestId, id, id);
  }
});

test("J: group waiting-confirm reuse — no owner notify, no Book kar du, DM unavailable suppress", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  seedAvr(fakeDb, "avr_waiting", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
    ownerNotificationStatus: "sent",
    requestedDuration: 2,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: logicalKeyFor(),
  });

  const plan = ownerCheckPlan({ turn: "msg-wc-reuse" });
  const sendCalls = [];
  const routed = await routeAndExecuteLiveActionPlan(plan, defaultFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-wc-reuse",
    guaranteeKey: "leads::cust-1::msg-wc-reuse",
    chatId: "leads",
    chatType: "group",
    participantKey: "cust-1",
    isGroupInbound: true,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
  });

  const check = routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED;
  assert.equal(check.requestId, "avr_waiting");
  assert.equal(check.created, false);
  assert.match(String(check.lifecycleKind), /waiting_confirm_reused/);
  assert.equal(check.dmContinuation, "unavailable_flag_off");
  assert.equal(
    routed.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION.reason,
    "WAITING_CONFIRM_NO_OWNER_NOTIFY"
  );
  assert.equal(sendCalls.length, 0);
  assert.equal(routed.bookingCreated, null);
  assert.equal(routed.customerReplySuppressed, true);
  assert.equal(String(routed.reply), "");
  assertNoOwnerCheckPromiseWording(routed.reply);
});

test("K: same item/duration, different explicit window → fresh AVR", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload: basePayload({
      sourceTurnKey: "leads::cust-1::msg-w1",
      requestedDates: ["2026-08-01", "2026-08-02"],
    }),
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  // Make first non-pending via waiting_confirm so only date gate is under test if pending blocked.
  // Pending is never semantically reused; seed a waiting_confirm with dates instead.
  seedAvr(fakeDb, "avr_wc_dates", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
    requestedDuration: 2,
    requestedDates: ["2026-08-01", "2026-08-02"],
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: logicalKeyFor({ requestedDates: ["2026-08-01", "2026-08-02"] }),
    ownerNotificationStatus: "sent",
  });
  const second = await createAvailabilityRequest({
    db: fakeDb,
    payload: basePayload({
      sourceTurnKey: "leads::cust-1::msg-w2",
      sourceMessageId: "msg-w2",
      guaranteeKey: "leads::cust-1::msg-w2",
      requestedDates: ["2026-09-10", "2026-09-11"],
      sourceIdentity: {
        participantKey: "cust-1",
        chatId: "leads",
        chatType: "group",
        sourceMessageId: "msg-w2",
        guaranteeKey: "leads::cust-1::msg-w2",
        sourceTurnKey: "leads::cust-1::msg-w2",
      },
    }),
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(second.requestId, "avr_wc_dates");
});

test("K2: old no dates + new explicit dates → no semantic reuse of waiting_confirm", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  seedAvr(fakeDb, "avr_wc_no_dates", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
    requestedDuration: 2,
    requestedDates: [],
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: logicalKeyFor(),
    ownerNotificationStatus: "sent",
  });
  const created = await createAvailabilityRequest({
    db: fakeDb,
    payload: basePayload({
      sourceTurnKey: "leads::cust-1::msg-with-dates",
      requestedDates: ["2026-08-01"],
    }),
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  assert.equal(created.created, true);
  assert.notEqual(created.requestId, "avr_wc_no_dates");
});

test("L: same explicit window + waiting_confirm → reuse", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const dates = ["2026-08-01", "2026-08-02"];
  seedAvr(fakeDb, "avr_wc_same", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
    requestedDuration: 2,
    requestedDates: dates,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey: logicalKeyFor({ requestedDates: dates }),
    ownerNotificationStatus: "sent",
  });
  const second = await createAvailabilityRequest({
    db: fakeDb,
    payload: basePayload({
      sourceTurnKey: "leads::cust-1::msg-same-w2",
      requestedDates: dates,
    }),
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  assert.equal(second.created, false);
  assert.equal(second.requestId, "avr_wc_same");
  assert.equal(second.lifecycleKind, "waiting_confirm_reused");
});

test("N: fresh AVR notification failure → suppress, no false check wording", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const plan = ownerCheckPlan({ turn: "msg-fail-notify" });
  const routed = await routeAndExecuteLiveActionPlan(plan, defaultFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-fail-notify",
    guaranteeKey: "leads::cust-1::msg-fail-notify",
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => {
      throw new Error("SEND_FAILED");
    },
  });
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.created, true);
  assert.equal(routed.customerReplySuppressed, true);
  assert.equal(String(routed.reply), "");
  assertNoOwnerCheckPromiseWording(routed.reply);
});

test("N2: notify execute off → suppress, no false check wording", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const plan = ownerCheckPlan({ turn: "msg-notify-off" });
  const flags = { ...defaultFlags, availabilityOwnerNotifyExecute: false };
  const routed = await routeAndExecuteLiveActionPlan(plan, flags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-notify-off",
    guaranteeKey: "leads::cust-1::msg-notify-off",
    chatId: "leads",
    participantKey: "cust-1",
  });
  assert.equal(routed.customerReplySuppressed, true);
  assert.equal(
    routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.replyDisposition,
    "SUPPRESS_NOTIFY_DISABLED"
  );
  assertNoOwnerCheckPromiseWording(routed.reply);
});

test("O: fresh AVR notification success allows deferral", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const plan = ownerCheckPlan({ turn: "msg-ok-notify" });
  const routed = await routeAndExecuteLiveActionPlan(plan, defaultFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-ok-notify",
    guaranteeKey: "leads::cust-1::msg-ok-notify",
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true, providerMessageId: "ok" }),
  });
  assert.equal(routed.customerReplySuppressed, false);
  assert.match(String(routed.reply), /mai confirm kar leta hun/i);
});

test("P: group owner-check path never creates a booking", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const plan = ownerCheckPlan({ turn: "msg-no-book" });
  const flags = { ...defaultFlags, bookingExecute: true };
  const routed = await routeAndExecuteLiveActionPlan(plan, flags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-no-book",
    guaranteeKey: "leads::cust-1::msg-no-book",
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
  });
  assert.equal(routed.bookingCreated, null);
  assert.equal(routed.sideEffectResults.CREATE_BOOKING, undefined);
});

test("deferral gate: IDEMPOTENT_SKIP requires open journey + queued/sending/sent", () => {
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "sent" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    true
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "queued" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    true
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "sending" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    true
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "failed" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    false
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "not_started" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    false
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    false
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: { status: "pending", ownerNotificationStatus: "sent" },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: false,
    }),
    false
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "waiting_confirm_reused",
        request: {
          status: "approved",
          customerConfirmationStatus: "waiting_confirm",
          ownerNotificationStatus: "sent",
        },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    false
  );
  assert.equal(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true,
        lifecycleKind: "exact_source_replay",
        request: {
          status: "approved",
          customerConfirmationStatus: "superseded",
          ownerNotificationStatus: "sent",
        },
      },
      notifyResult: { ok: true, skipped: true, reason: "IDEMPOTENT_SKIP" },
      notifyExecute: true,
    }),
    false
  );
  assert.equal(isOpenOwnerCheckJourney({ status: "pending" }), true);
  assert.equal(
    isOpenOwnerCheckJourney({
      status: "approved",
      customerConfirmationStatus: "superseded",
    }),
    false
  );
});

test("exact-source closed AVR with sent → suppress deferral wording", async () => {
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const payload = basePayload({ sourceTurnKey: "leads::cust-1::msg-closed-exact" });
  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { db: fakeDb, businessId: BUSINESS_ID },
  });
  const stored = getAvr(fakeDb, first.requestId);
  Object.assign(stored, {
    status: "approved",
    customerConfirmationStatus: "superseded",
    supersededByAvailabilityRequestId: "avr_other",
    ownerNotificationStatus: "sent",
  });
  fakeDb.docs.set(avrPath(first.requestId), stored);

  const plan = ownerCheckPlan({ turn: "msg-closed-exact" });
  const routed = await routeAndExecuteLiveActionPlan(plan, defaultFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-closed-exact",
    guaranteeKey: "leads::cust-1::msg-closed-exact",
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
  });
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED.requestId, first.requestId);
  assert.equal(routed.customerReplySuppressed, true);
  assertNoOwnerCheckPromiseWording(routed.reply);
});

test("ledger remains source of truth: done turn blocks re-admission (no second reply path)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avr-ledger-"));
  const prevEnabled = process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
  const prevPath = process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH;
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = path.join(tmp, "ledger.json");
  try {
    const guaranteeKey = "leads::wa::TEST_EXACT_REPLAY_LEDGER";
    markInboundTurnLedgerDone({
      chatKey: "leads",
      stableId: "wa::TEST_EXACT_REPLAY_LEDGER",
      guaranteeKey,
      textPreview: "corolla",
      replySent: true,
    });
    const block = resolveInboundTurnAdmissionBlock({
      chatKey: "leads",
      stableId: "wa::TEST_EXACT_REPLAY_LEDGER",
      guaranteeKey,
    });
    assert.ok(block);
    assert.equal(block.reason, "already_answered");
  } finally {
    if (prevEnabled == null) delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
    else process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = prevEnabled;
    if (prevPath == null) delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH;
    else process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = prevPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
