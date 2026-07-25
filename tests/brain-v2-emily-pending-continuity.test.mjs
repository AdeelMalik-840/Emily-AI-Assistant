/**
 * Full continuity matrix — Emily pending contract + meaning (Phases 2–3).
 * Example customer text is for tests only; product must not branch on exact phrases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAI_API_KEY ||= "sk-test-fake";
process.env.NODE_ENV = "test";

import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION,
  EMILY_PENDING_STAGE_CONFIRM,
  EMILY_PENDING_TTL_MS,
  buildEmilyPending,
  readEmilyPendingForParticipant,
  readFreshEmilyPending,
  toSessionPendingPersistence,
} from "../src/brain/availability/emilyPendingContext.js";
import {
  decideEmilyPendingFollowUp,
  decideEmilyPendingFollowUpDeterministic,
} from "../src/brain/availability/decideEmilyPendingFollowUp.js";
import { PENDING_ACTION_COLLECT_AVAILABILITY_DURATION } from "../src/brain/availability/availabilityPendingActions.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { getEmilySessionState, patchEmilySessionState } from "../src/services/conversationIntelligence.js";
import {
  hasOpenAvailabilityDurationPending,
  hasOpenCollectDurationPending,
  selectWorkflow,
} from "../src/brain/workflow/WorkflowEngine.js";
import { understandTurn } from "../src/brain/understanding/UnderstandingEngine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATALOG = [
  {
    id: "civic_1",
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    availability: true,
  },
  {
    id: "corolla_1",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla",
    availability: true,
  },
];

function admitted(text, participantKey = "cust-1") {
  return {
    turn: {
      turnId: `m-${String(text).slice(0, 12)}`,
      businessId: "biz-continuity",
      channelId: "whatsapp_web",
      chatKey: "group-1",
      participantKey,
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `id-${String(text).slice(0, 12)}`,
    admissionReason: "test",
  };
}

test("P2: buildEmilyPending stores question/stage/item/TTL/participant", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Civic ka mai check kar leta hun. Kitne din ke liye chahiye?",
    itemId: "civic_1",
    itemLabel: "Civic",
    participantKey: "cust-1",
    sourceWorkflow: "availability_inquiry",
    nowMs: 1_700_000_000_000,
    ttlMs: EMILY_PENDING_TTL_MS,
  });
  assert.ok(pending);
  assert.equal(pending.pendingStage, EMILY_PENDING_STAGE_AVAILABILITY_DURATION);
  assert.match(String(pending.pendingQuestion), /Kitne din/i);
  assert.equal(pending.itemId, "civic_1");
  assert.equal(pending.participantKey, "cust-1");
  assert.equal(pending.type, PENDING_ACTION_COLLECT_AVAILABILITY_DURATION);
  assert.ok(pending.expiresAt);
  const fresh = readFreshEmilyPending(pending, 1_700_000_000_000 + 1000);
  assert.ok(fresh);
  const expired = readFreshEmilyPending(
    pending,
    1_700_000_000_000 + EMILY_PENDING_TTL_MS + 1
  );
  assert.equal(expired, null);
});

test("P2: participant isolation for emilyPending", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: "civic_1",
    participantKey: "cust-a",
  });
  const mem = { emilyPending: pending, pendingAction: pending };
  assert.ok(
    readEmilyPendingForParticipant({
      memorySnapshot: mem,
      participantKey: "cust-a",
    })
  );
  assert.equal(
    readEmilyPendingForParticipant({
      memorySnapshot: mem,
      participantKey: "cust-b",
    }),
    null
  );
});

test("P2: session memory persists emilyPending + pendingAction together", () => {
  const sessionKey = `emily-pending-${Date.now()}`;
  patchEmilySessionState(sessionKey, {});
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din ke liye chahiye?",
    itemId: "civic_1",
    participantKey: "cust-1",
  });
  const persist = toSessionPendingPersistence(pending);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: { persistenceIntent: { ...persist, execute: false } },
  });
  const mem = getEmilySessionState(sessionKey);
  assert.equal(mem.pendingAction?.type, PENDING_ACTION_COLLECT_AVAILABILITY_DURATION);
  assert.equal(mem.emilyPending?.pendingStage, EMILY_PENDING_STAGE_AVAILABILITY_DURATION);
  assert.match(String(mem.emilyPending?.pendingQuestion), /Kitne din/i);
});

test("P3: availability_duration + duration → answer_pending / availability_inquiry", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: "civic_1",
  });
  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: { durationDays: 2, resolvedItemId: "civic_1", signals: {} },
    signals: {},
  });
  assert.equal(decided.meaning, "answer_pending");
  assert.equal(decided.workflowHint, "availability_inquiry");
});

test("P3: availability_duration + confirm-shaped → confirm meaning but availability workflow (no book)", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: "civic_1",
  });
  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: {
      resolvedItemId: "civic_1",
      signals: { bookingCommitment: true },
    },
    signals: { bookingCommitment: true },
  });
  assert.equal(decided.meaning, "confirm");
  assert.equal(decided.workflowHint, "availability_inquiry");
});

test("P3: availability_duration + price ask → question", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: "civic_1",
  });
  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: {
      durationDays: 2,
      resolvedItemId: "civic_1",
      signals: { priceAsk: true },
    },
    signals: { priceAsk: true },
  });
  assert.equal(decided.meaning, "question");
  assert.notEqual(decided.workflowHint, "booking_request");
});

test("P3: booking_collect_duration + duration → booking_request hint", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION,
    pendingQuestion: "Kitne din book karun?",
    itemId: "civic_1",
    type: "collect_duration",
  });
  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: { durationDays: 10, resolvedItemId: "civic_1", signals: {} },
    signals: {},
  });
  assert.equal(decided.meaning, "answer_pending");
  assert.equal(decided.workflowHint, "booking_request");
});

test("P3: confirm pending is advisory only (no gate bypass)", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_CONFIRM,
    pendingQuestion: "Book kar du?",
    itemId: "civic_1",
  });
  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: { signals: { bookingCommitment: true } },
    signals: { bookingCommitment: true },
  });
  assert.equal(decided.meaning, "confirm");
  assert.equal(decided.workflowHint, null);
});

test("P3: decideEmilyPendingFollowUp with no pending → new_request", () => {
  const decided = decideEmilyPendingFollowUp({
    memorySnapshot: {},
    participantKey: "cust-1",
    understanding: { durationDays: 2 },
  });
  assert.equal(decided.meaning, "new_request");
  assert.equal(decided.pending, null);
});

test("P3: WorkflowEngine still routes availability pending via emilyPending memory", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: "civic_1",
    participantKey: "cust-1",
  });
  const turnContext = {
    sessionId: "s1",
    businessId: "biz-continuity",
    participantKey: "cust-1",
    lastResolvedItemId: "civic_1",
    memorySnapshot: { emilyPending: pending, pendingAction: pending, lastResolvedItemId: "civic_1" },
  };
  assert.equal(hasOpenAvailabilityDurationPending(turnContext), true);
  assert.equal(hasOpenCollectDurationPending(turnContext), false);
  const understanding = understandTurn({
    admittedTurn: admitted("2 din k lye"),
    turnContext,
    catalogItems: CATALOG,
  });
  const wf = selectWorkflow({
    understanding,
    turnContext,
    message: "2 din k lye",
  });
  assert.equal(wf.workflowType, "availability_inquiry");
});

test("matrix safety: createBooking gate + Step4 flag unchanged", () => {
  const gate = readFileSync(join(ROOT, "src/services/executors/createBookingExecutor.js"), "utf8");
  assert.match(gate, /waiting_confirm/);
  assert.doesNotMatch(gate, /emilyPendingFollowUp/);
  const flags = readFileSync(join(ROOT, "src/brain/config/liveFeatureFlags.js"), "utf8");
  assert.match(flags, /EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED/);
  const meaning = readFileSync(
    join(ROOT, "src/brain/availability/decideEmilyPendingFollowUp.js"),
    "utf8"
  );
  assert.doesNotMatch(meaning, /message\s*===\s*["']kr do["']/);
  assert.doesNotMatch(meaning, /case\s+["']yes["']/);
});
