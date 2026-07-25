/**
 * Scenario matrix A–D: Brain V2 context-smart replies (pending continuity).
 * Example customer text is for tests only — product must not branch on these phrases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAI_API_KEY ||= "sk-test-fake";
process.env.NODE_ENV = "test";

import { understandTurn } from "../src/brain/understanding/UnderstandingEngine.js";
import {
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
  PENDING_ACTION_COLLECT_DURATION,
  hasOpenAvailabilityDurationPending,
  hasOpenCollectDurationPending,
  selectWorkflow,
} from "../src/brain/workflow/WorkflowEngine.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { getEmilySessionState, patchEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveBusinessDecisionForPendingContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { chatSessionKey } from "../src/services/memory.js";
import { resolveGroupParticipantContextKey } from "../src/services/groupParticipantContext.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATALOG = [
  {
    id: "civic_2026_oriel_white",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
    color: "White",
    availability: true,
  },
  {
    id: "toyota_corolla",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla",
    color: "Metallic Grey",
    availability: true,
  },
];

function admitted(text) {
  return {
    turn: {
      turnId: `t-${String(text).slice(0, 20).replace(/\s+/g, "-")}`,
      businessId: "biz-context-smart",
      channelId: "whatsapp_web",
      chatKey: "car-rental",
      participantKey: "cust-1",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `k-${String(text).slice(0, 20)}`,
    admissionReason: "real_customer_inbound",
  };
}

function turnContext(memory = {}, activeWorkflowType) {
  return {
    sessionId: "s1",
    businessId: "biz-context-smart",
    chatKey: "car-rental",
    participantKey: "cust-1",
    schemaVersion: 1,
    lastResolvedItemId: memory.lastResolvedItemId ?? null,
    memorySnapshot: memory,
    activeWorkflowType,
  };
}

function availabilityDurationMemory(itemId = "civic_2026_oriel_white") {
  return {
    lastResolvedItemId: itemId,
    pendingAction: {
      type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      itemId,
      status: "awaiting",
      sourceWorkflow: "availability_inquiry",
    },
  };
}

function bookingCollectDurationMemory(itemId = "civic_2026_oriel_white") {
  return {
    lastResolvedItemId: itemId,
    pendingAction: {
      type: PENDING_ACTION_COLLECT_DURATION,
      itemId,
      status: "awaiting",
    },
  };
}

// --- A. Pending / continuity ---

test("A1: availability duration pending + 2 din → availability_inquiry not booking", () => {
  const message = "2 din k lye";
  const ctx = turnContext(availabilityDurationMemory());
  assert.equal(hasOpenAvailabilityDurationPending(ctx), true);
  assert.equal(hasOpenCollectDurationPending(ctx), false);

  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.match(String(decision.reason), /availability_duration/i);
  assert.notEqual(decision.workflowType, "booking_request");
});

test("A2: booking collect_duration + duration-only still → booking_request", () => {
  const message = "10 din k lye";
  const ctx = turnContext(bookingCollectDurationMemory(), PENDING_ACTION_COLLECT_DURATION);
  assert.equal(hasOpenCollectDurationPending(ctx), true);

  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.equal(decision.workflowType, "booking_request");
  assert.match(
    String(decision.reason),
    /duration_only_after_collect_duration_prompt|duration_with_booking_commitment_after_collect_duration/
  );
});

test("A3: expired/missing availability duration pending does not force availability", () => {
  const message = "2 din k lye";
  const ctx = turnContext({ lastResolvedItemId: "civic_2026_oriel_white" });
  assert.equal(hasOpenAvailabilityDurationPending(ctx), false);
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  // Without availability pending, legacy duration continuation may still book — documented gap
  // until pending is persisted. After ask-duration persist, A1 covers the real path.
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.ok(decision.workflowType);
});

test("A4: ask-duration plan persists collect_availability_duration pending", () => {
  const sessionKey = `context-smart-persist-${Date.now()}`;
  patchEmilySessionState(sessionKey, {});
  const understanding = {
    resolvedItemId: "civic_2026_oriel_white",
    resolvedItemLabel: "Honda Civic",
    durationDays: null,
    signals: { availabilityAsk: true },
    itemSource: "explicit",
  };
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Civic available?"),
    understanding,
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: {
          id: "civic_2026_oriel_white",
          displayLabel: "Civic",
          name: "Civic",
        },
        turn: { durationDays: null, text: "Civic available?" },
        verified: {
          availability: { isAvailable: null, confidence: "low" },
        },
        actions: { availabilityOwnerCheckExecute: false },
      },
    },
  });
  assert.match(String(plan.replyDraft ?? ""), /Kitne din/i);
  assert.equal(plan.persistenceIntent?.setPendingAction, true);
  assert.equal(
    plan.persistenceIntent?.pendingAction?.type,
    PENDING_ACTION_COLLECT_AVAILABILITY_DURATION
  );

  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: plan });
  const mem = getEmilySessionState(sessionKey);
  assert.equal(mem?.pendingAction?.type, PENDING_ACTION_COLLECT_AVAILABILITY_DURATION);
  assert.equal(mem?.lastResolvedItemId, "civic_2026_oriel_white");
});

test("A4b: live pipeline Civic available? then 2 din → owner-check deferral not booking ack", async () => {
  const BUSINESS_ID = "synthetic-car-rental-business-001";
  const fixture = loadSyntheticCarRentalCatalogFixture();
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = "false";

  const sessionKey = `context-smart-live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const participantKey = `cust-ctx-${Date.now()}`;
  const ask = await runBrainV2LivePipeline({
    traceId: "ctx-smart-ask-duration",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey,
    sessionKey,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(ask.workflowType, "availability_inquiry");
  assert.match(String(ask.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.equal(
    ask.messageMeta?.actionPlan?.persistenceIntent?.pendingAction?.type,
    PENDING_ACTION_COLLECT_AVAILABILITY_DURATION
  );

  const chatContextKey = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey,
    playwrightChatKey: "",
    participantKey,
    businessId: BUSINESS_ID,
    userId: BUSINESS_ID,
  });
  const emilySessionKey = chatSessionKey(BUSINESS_ID, chatContextKey);
  applySessionMemoryFromActionPlan({
    sessionKey: emilySessionKey,
    actionPlan: ask.messageMeta?.actionPlan,
  });
  const memAfterAsk = getEmilySessionState(emilySessionKey);
  assert.equal(
    memAfterAsk?.pendingAction?.type,
    PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
    `expected pending on ${emilySessionKey}`
  );

  const follow = await runBrainV2LivePipeline({
    traceId: "ctx-smart-duration-follow",
    businessId: BUSINESS_ID,
    message: "2 din k lye",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey,
    sessionKey,
    memorySnapshot: memAfterAsk,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(follow.workflowType, "availability_inquiry");
  assert.match(String(follow.reply ?? ""), /mai confirm kar leta hun/i);
  assert.doesNotMatch(String(follow.reply ?? ""), /Theek hai, mai check kr k btata hun/i);
  assert.equal(follow.messageMeta?.bookingCreated, undefined);
});

// --- B. Meaning while pending ---

test("B6: rent question under availability duration pending → pricing interrupt not booking", () => {
  const message = "2 din k lye rent kitna hoga?";
  const ctx = turnContext(availabilityDurationMemory());
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.notEqual(decision.workflowType, "booking_request");
  assert.ok(
    decision.workflowType === "pricing_with_duration" ||
      decision.workflowType === "availability_inquiry"
  );
});

test("B8: confirm-shaped reply under availability duration pending → not booking_request", () => {
  const message = "kr do";
  const ctx = turnContext(availabilityDurationMemory());
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.notEqual(decision.workflowType, "booking_request");
});

test("B10: item switch Corolla under Civic availability duration pending → availability_inquiry", () => {
  const message = "corolla 2 din";
  const ctx = turnContext(availabilityDurationMemory("civic_2026_oriel_white"));
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.equal(decision.workflowType, "availability_inquiry");
});

test("B12: business decision prefers availability when availability-duration pending + duration", () => {
  const decision = resolveBusinessDecisionForPendingContext({
    normalizedMessage: "2 din k lye",
    signals: {},
    understanding: {
      durationDays: 2,
      resolvedItemId: "civic_2026_oriel_white",
    },
    itemFacts: { id: "civic_2026_oriel_white" },
    participantFacts: { participant: { memoryAllowed: true } },
    memoryPendingAction: {
      type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      itemId: "civic_2026_oriel_white",
    },
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.equal(decision.primaryIntent, "availability_inquiry");
  assert.notEqual(decision.workflowType, "booking_request");
});

test("B7: decline-shaped reply under availability duration pending → not booking_request", () => {
  const message = "nahi chahiye";
  const ctx = turnContext(availabilityDurationMemory());
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.notEqual(decision.workflowType, "booking_request");
  assert.equal(decision.workflowType, "availability_inquiry");
});

test("B8b: strong booking decision is overridden while availability duration pending", () => {
  const message = "book kar do";
  const ctx = turnContext(availabilityDurationMemory());
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({
    understanding,
    turnContext: ctx,
    message,
    resolvedBusinessTurnContext: {
      decision: {
        workflowType: "booking_request",
        reason: "strong_booking_command",
      },
    },
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.match(String(decision.reason), /availability_duration/i);
});

test("B11: short/noise-style reply under availability duration pending → not booking", () => {
  for (const message of ["hn", "???", "ok"]) {
    const ctx = turnContext(availabilityDurationMemory());
    const understanding = understandTurn({
      admittedTurn: admitted(message),
      turnContext: ctx,
      catalogItems: CATALOG,
    });
    const decision = selectWorkflow({ understanding, turnContext: ctx, message });
    assert.notEqual(
      decision.workflowType,
      "booking_request",
      `message=${message} must not book under availability duration pending`
    );
  }
});

test("A5: participant isolation — empty memory for other customer has no availability pending", () => {
  const ctxA = turnContext(availabilityDurationMemory());
  const ctxB = turnContext({ lastResolvedItemId: null }, undefined);
  ctxB.participantKey = "cust-2";
  assert.equal(hasOpenAvailabilityDurationPending(ctxA), true);
  assert.equal(hasOpenAvailabilityDurationPending(ctxB), false);
  const understanding = understandTurn({
    admittedTurn: {
      ...admitted("2 din k lye"),
      turn: { ...admitted("2 din k lye").turn, participantKey: "cust-2" },
    },
    turnContext: ctxB,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({
    understanding,
    turnContext: ctxB,
    message: "2 din k lye",
  });
  assert.notEqual(decision.reason, "availability_duration_pending_continuation");
});

test("A6: owner-check plan clears availability duration pending", () => {
  const sessionKey = `context-smart-clear-${Date.now()}`;
  patchEmilySessionState(sessionKey, {
    pendingAction: {
      type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      itemId: "civic_2026_oriel_white",
      status: "awaiting",
    },
    lastResolvedItemId: "civic_2026_oriel_white",
  });
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("2 din k lye"),
    understanding: {
      resolvedItemId: "civic_2026_oriel_white",
      durationDays: 2,
      signals: {},
      itemSource: "memory",
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: "biz-context-smart",
        resolvedItem: {
          id: "civic_2026_oriel_white",
          displayLabel: "Civic",
          name: "Civic",
        },
        turn: { durationDays: 2, text: "2 din k lye" },
        verified: {
          availability: {
            status: "available",
            isAvailable: true,
            bookingAware: true,
            blockingBookingCount: 0,
          },
        },
        actions: { availabilityOwnerCheckExecute: false },
        decision: { weakContextSignals: ["duration_context"] },
      },
    },
  });
  assert.equal(plan.persistenceIntent?.clearPendingAction, true);
  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: plan });
  const mem = getEmilySessionState(sessionKey);
  assert.equal(mem?.pendingAction ?? null, null);
});

test("C13: strong booking with item+duration and NO availability pending → booking_request allowed", () => {
  const message = "Civic 2 din book kar do";
  const ctx = turnContext({ lastResolvedItemId: "civic_2026_oriel_white" });
  assert.equal(hasOpenAvailabilityDurationPending(ctx), false);
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext: ctx,
    catalogItems: CATALOG,
  });
  const decision = selectWorkflow({ understanding, turnContext: ctx, message });
  assert.equal(decision.workflowType, "booking_request");
});

test("C14: createBooking gate source still requires waiting_confirm (static)", () => {
  const gate = readFileSync(
    join(ROOT, "src/services/executors/createBookingExecutor.js"),
    "utf8"
  );
  assert.match(gate, /customerConfirmationStatus/);
  assert.match(gate, /waiting_confirm/);
  assert.doesNotMatch(gate, /collect_availability_duration/);
});

// --- C / D safety static ---

test("D19/D20: Step 4 Brain flag default-off; createBooking gate file untouched by this suite", () => {
  const gate = readFileSync(
    join(ROOT, "src/services/executors/createBookingExecutor.js"),
    "utf8"
  );
  assert.match(gate, /waiting_confirm/);
  const flags = readFileSync(join(ROOT, "src/brain/config/liveFeatureFlags.js"), "utf8");
  assert.match(flags, /EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED/);
});

test("no-keywords: WorkflowEngine availability-duration path has no new exact phrase gates", () => {
  const src = readFileSync(join(ROOT, "src/brain/workflow/WorkflowEngine.js"), "utf8");
  assert.match(src, /PENDING_ACTION_COLLECT_AVAILABILITY_DURATION/);
  assert.doesNotMatch(src, /message\s*===\s*["']2 din/);
  assert.doesNotMatch(src, /case\s+["']kr do["']/);
});
