/**
 * Issue 1 — booking gate consistency.
 * Canonical resolveBusinessDecision.workflowType is the single booking-intent
 * source of truth for Fix 1/2 (no second strongBookingCommand phrase gate).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";

import { extractTurnSignals } from "../src/services/intentShapeResolver.js";
import {
  resolveBusinessDecisionForPendingContext,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import {
  routeAndExecuteLiveActionPlan,
  routeLiveActionPlan,
} from "../src/brain/live/actionRouter.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { validateBrainV2PipelineResult } from "../src/brain/live/brainV2ResultContract.js";
import { buildLogicalAvailabilityRequestKey } from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "biz-gate-consistency";
const COROLLA_ID = "toyota_corolla_metallic_grey_0e2cd610";
const COROLLA_LABEL = "Toyota Corolla (Metallic Grey)";
const CIVIC_ID = "honda_civic_white_aaa";
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

async function seedBusiness(fakeDb) {
  await fakeDb.collection("businesses").doc(BUSINESS_ID).set({
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: { ownerNotificationPhone: OWNER_PHONE },
  });
}

function decideMessage(message, { itemId, itemLabel, durationDays }) {
  const signals = extractTurnSignals({
    message,
    hasDuration: durationDays != null,
    itemMentioned: Boolean(itemId),
  });
  const decision = resolveBusinessDecisionForPendingContext({
    normalizedMessage: String(message).toLowerCase().replace(/\s+/g, " ").trim(),
    understanding: { durationDays, resolvedItemId: itemId },
    signals,
    itemFacts: itemId ? { id: itemId, label: itemLabel } : {},
    participantFacts: { participant: { memoryAllowed: true } },
  });
  const workflow = selectWorkflow({
    understanding: {
      resolvedItemId: itemId,
      durationDays,
      signals,
      itemSource: itemId ? "explicit" : "none",
    },
    turnContext: { memorySnapshot: null },
    message,
    resolvedBusinessTurnContext: { decision },
  });
  return { signals, decision, workflow };
}

function availableCanonical({ turn, strongBookingCommand = false, itemId = COROLLA_ID }) {
  const sourceTurnKey = `leads::cust-1::${turn}`;
  return {
    businessId: BUSINESS_ID,
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      strongBookingCommand,
      reason: strongBookingCommand
        ? "strong_booking_command"
        : "explicit_booking_commitment",
    },
    turn: {
      durationDays: 3,
      sourceMessageId: turn,
      sourceRowKey: `row-${turn}`,
      guaranteeKey: sourceTurnKey,
      sourceTurnKey,
    },
    participant: { key: "cust-1", identity: "stable", memoryAllowed: true },
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
        verifiedAlternatives: [],
      },
    },
    resolvedItem: { id: itemId, displayLabel: COROLLA_LABEL, name: COROLLA_LABEL },
  };
}

const liveFlags = {
  bookingExecute: true,
  ownerExecute: true,
  dmExecute: false,
  availabilityOwnerCheckExecute: true,
  availabilityOwnerNotifyExecute: true,
};

test("1: kr do + trusted item/duration → booking_request owner-check (no CREATE_BOOKING)", async () => {
  const msg = "Toyota corolla 3 din k lye kr do";
  const { signals, decision, workflow } = decideMessage(msg, {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationDays: 3,
  });
  assert.equal(signals.bookingCommitment, true);
  assert.equal(signals.strongBookingCommitment, false);
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(decision.strongBookingCommand, false);
  assert.equal(decision.reason, "explicit_booking_commitment");
  assert.equal(workflow.workflowType, "booking_request");

  const turn = `kr-do-${randomUUID().slice(0, 8)}`;
  const canonical = availableCanonical({ turn, strongBookingCommand: false });
  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: msg, businessId: BUSINESS_ID, messageId: `wa::${turn}` } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: 3,
      signals,
    },
    businessContext: { resolvedBusinessTurnContext: canonical },
  });

  assert.equal(plan.workflowType, "booking_request");
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(plan.postExecuteCustomerReply, "owner_check_result");

  const fakeDb = new FakeDb();
  await seedBusiness(fakeDb);
  const routed = await routeAndExecuteLiveActionPlan(plan, liveFlags, {
    db: fakeDb,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
    messageId: turn,
    guaranteeKey: canonical.turn.sourceTurnKey,
    chatId: "leads",
    participantKey: "cust-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
  });
  assert.equal(routed.sideEffectResults.CREATE_BOOKING, undefined);
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.ok, true);
  assert.equal(routed.sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED?.created, true);
  assert.ok(routed.sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION);
  assert.equal(routed.awaitsPostExecuteBrainReply, true);
  assert.ok(buildLogicalAvailabilityRequestKey);
});

test("2: weak need chyh stays availability_inquiry — no booking owner-check escalation", () => {
  const { decision, workflow } = decideMessage("Civic 3 din k lye chyh", {
    itemId: CIVIC_ID,
    itemLabel: "Civic",
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.match(decision.reason, /owner_availability_check/i);
  assert.equal(workflow.workflowType, "availability_inquiry");
  assert.notEqual(decision.workflowType, "booking_request");
});

test("3: pricing stays pricing — no booking owner-check", () => {
  const { decision, workflow } = decideMessage("Civic 3 din ka rent kitna hai?", {
    itemId: CIVIC_ID,
    itemLabel: "Civic",
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "pricing_with_duration");
  assert.equal(workflow.workflowType, "pricing_with_duration");
});

test("4: availability mil jaye stays availability — no booking owner-check", () => {
  const { decision, workflow } = decideMessage("Civic mil jaye ge?", {
    itemId: CIVIC_ID,
    itemLabel: "Civic",
    durationDays: null,
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.equal(workflow.workflowType, "availability_inquiry");
});

test("5: book kar do with trusted item+duration → owner-check booking path", () => {
  const { decision, workflow } = decideMessage("Toyota corolla 3 din k lye book kar do", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(decision.strongBookingCommand, true);
  assert.equal(workflow.workflowType, "booking_request");

  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "book kar do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: 3,
      signals: { bookingCommitment: true, strongBookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: availableCanonical({
        turn: "book-kar",
        strongBookingCommand: true,
      }),
    },
  });
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
});

test("6: confirm kar do with trusted item+duration → owner-check booking path", () => {
  const { decision, workflow } = decideMessage("Toyota corolla 3 din k lye confirm kar do", {
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(decision.strongBookingCommand, true);
  assert.equal(workflow.workflowType, "booking_request");

  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "confirm kar do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: 3,
      signals: { bookingCommitment: true, strongBookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: availableCanonical({
        turn: "confirm-kar",
        strongBookingCommand: true,
      }),
    },
  });
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
});

test("7: missing item or duration → no AVR / no CREATE_BOOKING", () => {
  const signals = { bookingCommitment: true, strongBookingCommitment: false };
  const noItem = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "3 din k lye kr do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: null,
      resolvedItemLabel: "item",
      durationDays: 3,
      signals,
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        ...availableCanonical({ turn: "no-item" }),
        resolvedItem: { id: null, displayLabel: null, name: null },
        decision: {
          ...availableCanonical({ turn: "no-item" }).decision,
          resolvedItemId: null,
        },
      },
    },
  });
  assert.equal(noItem.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    noItem.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(noItem.actions[0]?.type, "NO_OP");
  assert.equal(noItem.actions[0]?.payload?.intentionallySilent, true);

  const noDuration = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "Corolla kr do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: null,
      signals,
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        ...availableCanonical({ turn: "no-dur" }),
        turn: { ...availableCanonical({ turn: "no-dur" }).turn, durationDays: null },
        duration: {
          days: null,
          source: "none",
          trustedContinuation: false,
          windowStartAt: null,
          windowEndAt: null,
          calendarRelative: null,
        },
        decision: {
          ...availableCanonical({ turn: "no-dur" }).decision,
          durationDays: null,
        },
      },
    },
  });
  assert.equal(noDuration.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    noDuration.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(noDuration.actions[0]?.payload?.intentionallySilent, true);
});

test("incomplete booking intentional NO_OP maps to structured silence (not SENDABLE_REPLY_MISSING)", async () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "kr do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: null,
      durationDays: null,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        decision: { workflowType: "booking_request", strongBookingCommand: false },
      },
    },
  });
  assert.equal(plan.actions[0]?.payload?.intentionallySilent, true);

  const result = await runBrainV2LivePipeline({
    traceId: `silent-book-${randomUUID()}`,
    businessId: BUSINESS_ID,
    message: "kr do",
    catalogItems: [],
    isGroupInbound: true,
    chatType: "group",
    playwrightWebInbound: true,
    sessionKey: `${BUSINESS_ID}::leads`,
    participantKey: "cust-1",
    memorySnapshot: {},
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "booking_request", reason: "test" },
      understanding: { resolvedItemId: null, durationDays: null, signals: {} },
      actionPlan: plan,
      resolvedBusinessTurnContext: {
        decision: { workflowType: "booking_request" },
      },
      trace: {},
    }),
  });

  assert.equal(result.sendVia, "NONE");
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.match(
    String(result.reason ?? ""),
    /booking_request_no_executable_action|INTENTIONAL_SILENT/
  );
  const validation = validateBrainV2PipelineResult(result);
  assert.equal(validation.ok, true);
  assert.notEqual(validation.reason, "SENDABLE_REPLY_MISSING");
});

test("Fix 1 unavailable still REPLY-only when workflowType is booking_request without strong flag", () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "Corolla 3 din k lye kr do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      durationDays: 3,
      signals: { bookingCommitment: true, strongBookingCommitment: false },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        ...availableCanonical({ turn: "fix1-unavail", strongBookingCommand: false }),
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
          "Toyota Corolla (Metallic Grey) 3 din ke liye available nahi hai.",
      },
    },
  });
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.type, "REPLY");
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.match(String(plan.replyDraft), /available nahi hai/i);

  const routed = routeLiveActionPlan(plan, liveFlags);
  assert.equal(routed.actions.some((a) => a.type === "CREATE_BOOKING" && a.allowed), false);
});
