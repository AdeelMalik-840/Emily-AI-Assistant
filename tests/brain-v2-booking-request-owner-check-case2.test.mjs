/**
 * Fix 2: appears-available strong booking_request → existing owner-check / AVR lane.
 * No direct CREATE_BOOKING; CASE 1 unavailable remains REPLY-only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import { buildOwnerCheckActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  routeAndExecuteLiveActionPlan,
  routeLiveActionPlan,
} from "../src/brain/live/actionRouter.js";
import { buildLogicalAvailabilityRequestKey } from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "biz-fix2-owner-check";
const COROLLA_ID = "toyota_corolla_metallic_grey_0e2cd610";
const COROLLA_LABEL = "Toyota Corolla (Metallic Grey)";
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

async function seedBusiness(fakeDb) {
  await fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: { ownerNotificationPhone: OWNER_PHONE },
  });
}

function sourceKeys(turn = "msg-book-1") {
  const sourceTurnKey = `leads::cust-1::${turn}`;
  return {
    sourceTurnKey,
    guaranteeKey: sourceTurnKey,
    sourceMessageId: turn,
    sourceRowKey: `row-${turn}`,
    sourceIdentity: {
      participantKey: "cust-1",
      participantIdentity: "stable",
      chatId: "leads",
      chatType: "group",
      sourceMessageId: turn,
      sourceRowKey: `row-${turn}`,
      guaranteeKey: sourceTurnKey,
      sourceTurnKey,
    },
    participant: { key: "cust-1", identity: "stable", memoryAllowed: true },
  };
}

function availableCanonical(overrides = {}) {
  const keys = sourceKeys(overrides.turn ?? "msg-book-1");
  return {
    businessId: BUSINESS_ID,
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      strongBookingCommand: true,
    },
    turn: {
      durationDays: 5,
      sourceMessageId: keys.sourceMessageId,
      sourceRowKey: keys.sourceRowKey,
      guaranteeKey: keys.guaranteeKey,
      sourceTurnKey: keys.sourceTurnKey,
    },
    participant: keys.participant,
    sourceIdentity: keys.sourceIdentity,
    actions: {
      allowed: ["AVAILABILITY_OWNER_CHECK_REQUIRED"],
      availabilityOwnerCheckExecute: true,
      bookingExecute: true,
      ownerExecute: true,
    },
    verified: {
      availability: {
        status: "available",
        isAvailable: true,
        windowApplied: true,
        reason: "no_blocking_bookings",
        requestedStartAt: "2026-08-10T00:00:00.000Z",
        requestedEndAt: "2026-08-15T00:00:00.000Z",
        verifiedAlternatives: [],
      },
    },
    ...overrides.contextExtras,
  };
}

function unavailableCanonical() {
  return {
    ...availableCanonical(),
    verified: {
      availability: {
        status: "unavailable",
        isAvailable: false,
        windowApplied: true,
        reason: "booking_conflict",
        verifiedAlternatives: [],
      },
    },
    unavailableCustomerReply:
      "Toyota Corolla (Metallic Grey) 5 din ke liye available nahi hai. Filhal koi dusri car available nahi hai.",
  };
}

function planBooking(canonical, text = "Corolla 5 din ke liye book kar do") {
  return buildBookingRequestActionPlan({
    admittedTurn: {
      turn: {
        text,
        businessId: BUSINESS_ID,
        messageId: `wa::${canonical?.turn?.sourceMessageId ?? "msg"}`,
      },
    },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: 5,
      signals: { bookingCommitment: true, strongBookingCommitment: true },
    },
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

function assertNoDirectBooking(plan) {
  assert.equal(plan.workflowType, "booking_request");
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "NOTIFY_OWNER"),
    false
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /mai check kr k btata hun/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /owner|approval|system|workflow|retry/i);
}

const liveFlags = {
  bookingExecute: true,
  ownerExecute: true,
  dmExecute: false,
  availabilityOwnerCheckExecute: true,
  availabilityOwnerNotifyExecute: true,
};

test("CASE A: appears available → booking_request owner-check plan, no CREATE_BOOKING", async () => {
  const canonical = availableCanonical({ turn: "msg-a" });
  const plan = planBooking(canonical);
  assertNoDirectBooking(plan);
  assert.equal(plan.postExecuteCustomerReply, "owner_check_result");
  const ownerAction = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload?.execute, true);
  assert.equal(ownerAction.payload?.itemId, COROLLA_ID);
  assert.equal(ownerAction.payload?.durationDays, 5);
  assert.equal(String(plan.replyDraft ?? "").trim(), "");

  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const routed = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-a",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
  });

  assert.equal(routed.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.ok, true);
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, true);
  assert.ok(routed.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION);
  // actionRouter hands wording to the existing post-execute Brain lane (pipeline).
  const post = routed.sideEffectResults.OWNER_CHECK_POST_EXECUTE_RESULT;
  assert.ok(post);
  assert.equal(post.awaitsReply, true);
  assert.equal(routed.awaitsPostExecuteBrainReply, true);
  assert.equal(String(routed.reply ?? "").trim(), "");
  assert.doesNotMatch(
    String(routed.reply ?? ""),
    /mai check kr k btata hun|owner approval|system|workflow/i
  );
});

test("CASE B: exact source replay → no duplicate AVR, no CREATE_BOOKING", async () => {
  const canonical = availableCanonical({ turn: "msg-b-same" });
  const plan = planBooking(canonical);
  assertNoDirectBooking(plan);

  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const first = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-b-same",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __decideCustomerTurnForTests: async () => ({
      action: "reply",
      shouldReply: true,
      customerReply: "Theek hai, check karke batati hun.",
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }),
  });
  const firstId = first.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.requestId;
  assert.ok(firstId);

  const second = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-b-same",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __decideCustomerTurnForTests: async () => ({
      action: "reply",
      shouldReply: true,
      customerReply: "Theek hai, check karke batati hun.",
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }),
  });
  assert.equal(second.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(second.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.requestId, firstId);
  assert.equal(second.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, false);
});

test("CASE C: reusable waiting_confirm AVR → reuse lifecycle, no CREATE_BOOKING", async () => {
  const canonical = availableCanonical({ turn: "msg-c-reuse" });
  const plan = planBooking(canonical);
  assertNoDirectBooking(plan);

  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const logicalRequestKey = buildLogicalAvailabilityRequestKey({
    businessId: BUSINESS_ID,
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    requestedDuration: 5,
    requestedDates: [],
  });
  seedAvr(fakeDb, "avr_reuse_existing", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000),
    requestedDuration: 5,
    requestedDates: [],
    customerParticipantId: "cust-1",
    sourceChatId: "leads",
    logicalRequestKey,
    ownerNotificationStatus: "sent",
  });

  const routed = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-c-reuse",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    chatType: "group",
    participantKey: "cust-1",
    isGroupInbound: true,
    sendWhatsAppMessageFn: async () => ({ ok: true }),
  });

  assert.equal(routed.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(
    routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.requestId,
    "avr_reuse_existing"
  );
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, false);
  assert.match(
    String(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.lifecycleKind),
    /waiting_confirm_reused/
  );
});

test("CASE D: confidently unavailable → Fix 1 REPLY only", () => {
  const plan = planBooking(unavailableCanonical());
  assert.equal(plan.workflowType, "booking_request");
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "REPLY");
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  // Wording is composed later through the shared guarded composer, not
  // authored by the workflow -- the structured marker proves this plan is
  // routed to the unavailable-availability composition lane.
  assert.equal(String(plan.replyDraft), "");
  assert.equal(plan.customerResponseComposition?.lane, "availability");
  assert.equal(plan.customerResponseComposition?.kind, "availability_unavailable");
});

test("CASE E: shared helper used; waiting_confirm confirmation lane untouched in workflow", () => {
  const bookingSrc = readFileSync(
    new URL("../src/brain/workflows/BookingRequestWorkflow.js", import.meta.url),
    "utf8"
  );
  const confirmSrc = readFileSync(
    new URL("../src/services/availabilityCustomerConfirmService.js", import.meta.url),
    "utf8"
  );
  assert.match(bookingSrc, /buildOwnerCheckActionPlan/);
  assert.doesNotMatch(bookingSrc, /createAvailabilityRequest|waiting_confirm/);
  assert.match(confirmSrc, /executeCreateBooking/);
  assert.match(confirmSrc, /waiting_confirm/);

  const availabilityPlan = buildOwnerCheckActionPlan({
    canonical: {
      businessId: BUSINESS_ID,
      turn: { durationDays: 5 },
      verified: { availability: { status: "available", isAvailable: true } },
    },
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationN: 5,
    execute: true,
  });
  const bookingPlan = planBooking(availableCanonical({ turn: "msg-e-shape" }));
  assert.equal(
    availabilityPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(
    bookingPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(bookingPlan.workflowType, "booking_request");
  assert.equal(availabilityPlan.workflowType, undefined);
});

test("CASE F: owner notify failure/off → no CREATE_BOOKING fallback, suppress success ack", async () => {
  const canonical = availableCanonical({ turn: "msg-f-fail" });
  const plan = planBooking(canonical);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);

  const failed = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-f-fail",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => {
      throw new Error("SEND_FAILED");
    },
  });
  assert.equal(failed.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(failed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, true);
  assert.equal(failed.customerReplySuppressed, true);
  assert.equal(String(failed.reply ?? "").trim(), "");

  const canonicalOff = availableCanonical({ turn: "msg-f-off" });
  const planOff = planBooking(canonicalOff);
  const fakeDbOff = new FakeDb();
  await seedBusiness(fakeDbOff);
  const off = await routeAndExecuteLiveActionPlan(
    planOff,
    { ...liveFlags, availabilityOwnerNotifyExecute: false },
    {
      db: fakeDbOff,
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      messageId: "msg-f-off",
      guaranteeKey: canonicalOff.turn.sourceTurnKey,
      chatId: "leads",
      participantKey: "cust-1",
      sendWhatsAppMessageFn: async () => ({ ok: true }),
    }
  );
  assert.equal(off.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(off.customerReplySuppressed, true);
  assert.equal(String(off.reply ?? "").trim(), "");
});

test("CASE G: post-execute OpenAI composition failure → fail-closed silence, no CREATE_BOOKING", async () => {
  const canonical = availableCanonical({ turn: "msg-g-compose" });
  const plan = planBooking(canonical);
  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);

  const routed = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: "msg-g-compose",
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __decideCustomerTurnForTests: async () => {
      throw new Error("OPENAI_COMPOSE_FAILED");
    },
  });

  assert.equal(routed.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.ok, true);
  assert.doesNotMatch(String(routed.reply ?? ""), /system|error|retry|technical|workflow/i);
});

test("booking CREATE_BOOKING execute flag alone cannot route booking_request to CREATE_BOOKING", () => {
  const plan = planBooking({
    ...availableCanonical({ turn: "msg-flag" }),
    actions: {
      allowed: ["CREATE_BOOKING", "NOTIFY_OWNER"],
      bookingExecute: true,
      ownerExecute: true,
      availabilityOwnerCheckExecute: true,
    },
  });
  assertNoDirectBooking(plan);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  const routed = routeLiveActionPlan(plan, {
    bookingExecute: true,
    ownerExecute: true,
    availabilityOwnerCheckExecute: true,
  });
  assert.equal(
    routed.actions.some((a) => a.type === "CREATE_BOOKING" && a.allowed),
    false
  );
});
