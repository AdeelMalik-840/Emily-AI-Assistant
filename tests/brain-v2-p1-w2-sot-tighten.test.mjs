/**
 * W2 + cross-risk: narrow WorkflowEngine late booking invent;
 * P1 emilyPending must not unlock lastDurationDays.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { extractTurnSignals } from "../src/services/intentShapeResolver.js";
import {
  resolveBusinessDecisionForPendingContext,
  hasTrustedDurationContinuation,
  resolveCanonicalRentalDuration,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import {
  buildOfferedAlternativesAssist,
  readFreshLastAvailabilityAssist,
} from "../src/brain/availability/availabilityAssistContext.js";
import {
  buildEmilyPending,
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
} from "../src/brain/availability/emilyPendingContext.js";
import { parseUserDuration } from "../src/duration/parseDuration.js";

const COROLLA = "toyota_corolla_metallic_grey_fixture";
const CIVIC = "honda_civic_2026_oriel_white_7e961e31";

function decideAndSelect(message, { itemId = COROLLA, durationDays, memory = {} } = {}) {
  const parsed = parseUserDuration(message);
  const dur =
    durationDays !== undefined
      ? durationDays
      : parsed?.normalizedDays != null
        ? Math.max(1, Math.floor(Number(parsed.normalizedDays)))
        : null;
  const signals = extractTurnSignals({
    message,
    hasDuration: dur != null,
    itemMentioned: Boolean(itemId),
  });
  const decision = resolveBusinessDecisionForPendingContext({
    normalizedMessage: String(message).toLowerCase().replace(/\s+/g, " ").trim(),
    understanding: { durationDays: dur, resolvedItemId: itemId },
    signals,
    itemFacts: itemId ? { id: itemId, label: "Item" } : {},
    participantFacts: { participant: { memoryAllowed: true } },
    memoryPendingAction: memory.pendingAction ?? memory.emilyPending ?? null,
    canonicalDurationDays: dur,
  });
  const wf = selectWorkflow({
    understanding: {
      resolvedItemId: itemId,
      durationDays: dur,
      signals,
      itemSource: itemId ? "explicit" : "none",
    },
    message,
    turnContext: { memorySnapshot: memory, businessId: "biz-w2" },
    resolvedBusinessTurnContext: { decision },
  });
  return { signals, decision, wf };
}

test("W2-A: 3 din k lye kr do → canonical booking_request unchanged", () => {
  const { decision, wf } = decideAndSelect("Toyota corolla 3 din k lye kr do", {
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(wf.workflowType, "booking_request");
});

test("W2-B: book kar do with duration → booking_request", () => {
  const { decision, wf } = decideAndSelect("Toyota corolla 3 din k lye book kar do", {
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(wf.workflowType, "booking_request");
});

test("W2-C: confirm kar do with item → booking_request via strong commitment", () => {
  const { decision, wf } = decideAndSelect("confirm kar do", {
    itemId: COROLLA,
    durationDays: 3,
  });
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(wf.workflowType, "booking_request");
});

test("W2-D: bare kr do + fresh assist → availability_inquiry (not phrase booking)", () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC,
    durationDays: 3,
    participantKey: "adeel",
  });
  const { decision, wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: { lastAvailabilityAssist: assist },
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.equal(wf.reason, "availability_assist_follow_up_pending");
});

test("W2-E: bare kr do + collect_duration pending → lifecycle booking continuation", () => {
  const memory = {
    pendingAction: {
      type: "collect_duration",
      itemId: COROLLA,
      status: "awaiting",
    },
  };
  const { wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory,
  });
  // collect_duration pending is an early lifecycle gate (before unknown bypass).
  assert.ok(
    wf.workflowType === "booking_request" || wf.workflowType === "clarification",
    `expected lifecycle continuation, got ${wf.workflowType}/${wf.reason}`
  );
  if (wf.workflowType === "booking_request") {
    assert.match(
      String(wf.reason),
      /collect_duration|booking_commitment|duration_only_after_collect/
    );
  }
});

test("W2-F: bare kr do + availability_duration pending → NOT booking_request", () => {
  const emilyPending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: COROLLA,
    participantKey: "adeel",
    type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
  });
  const { wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: {
      emilyPending,
      pendingAction: emilyPending,
    },
  });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.notEqual(wf.workflowType, "booking_request");
});

test("W2-G: bare kr do + item only → unknown, no phrase invent", () => {
  const { decision, wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: {},
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.equal(wf.workflowType, "unknown_clarification");
  assert.equal(wf.reason, "canonical_decision_unresolved_no_phrase_booking_invent");
});

test("W2-H: bare kr do + stale item/duration only → no booking invent", () => {
  const { decision, wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: { lastResolvedItemId: COROLLA, lastDurationDays: 5 },
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.equal(wf.workflowType, "unknown_clarification");
  assert.equal(
    hasTrustedDurationContinuation({
      memorySnapshot: { lastDurationDays: 5 },
    }),
    false
  );
});

test("W2-I: bare kr do + active AVR → no phrase booking invent", () => {
  const { decision, wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: {
      activeAvailabilityRequest: { requestedDuration: 4, status: "pending" },
    },
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.equal(wf.workflowType, "unknown_clarification");
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    activeAvrDurationDays: 4,
    trustedContinuation: true,
  });
  assert.equal(packed.source, "avr");
  assert.equal(packed.days, 4);
});

test("W2-J: waiting_confirm + kr do → no new phrase booking invent", () => {
  // waiting_confirm is owned by DM confirmation lane upstream; WorkflowEngine
  // must not manufacture a competing booking_request when canonical is unknown.
  const { decision, wf } = decideAndSelect("kr do", {
    itemId: COROLLA,
    durationDays: null,
    memory: {
      activeAvailabilityRequest: {
        status: "pending",
        customerConfirmationStatus: "waiting_confirm",
        requestedDuration: 3,
      },
    },
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.notEqual(wf.workflowType, "booking_request");
  assert.equal(wf.workflowType, "unknown_clarification");
  assert.equal(wf.reason, "canonical_decision_unresolved_no_phrase_booking_invent");
});

test("CROSS-RISK: info pending + lastDurationDays=5 + Civic kr do → no leak, no invent", () => {
  const info = buildEmilyPending({
    stage: "info",
    pendingQuestion: "Kya poochna hai?",
    participantKey: "adeel",
  });
  const memory = {
    lastDurationDays: 5,
    lastResolvedItemId: COROLLA,
    emilyPending: info,
  };
  assert.equal(
    hasTrustedDurationContinuation({
      memorySnapshot: memory,
      participantKey: "adeel",
    }),
    false
  );
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    sessionDurationDays: 5,
    trustedContinuation: false,
  });
  assert.equal(packed.days, null);
  assert.equal(packed.source, "none");

  const { decision, wf } = decideAndSelect("Civic kr do", {
    itemId: CIVIC,
    durationDays: null,
    memory,
  });
  assert.equal(decision.workflowType, "unknown_clarification");
  assert.equal(wf.workflowType, "unknown_clarification");
  assert.notEqual(wf.workflowType, "booking_request");
});

test("W2 preserves: without canonical decision object, legacy late phrase may still run", () => {
  // Older call sites without resolvedBusinessTurnContext keep helpers available.
  const wf = selectWorkflow({
    understanding: {
      resolvedItemId: COROLLA,
      durationDays: null,
      signals: { bookingCommitment: false },
      itemSource: "explicit",
    },
    message: "kr do",
    turnContext: { memorySnapshot: {} },
    resolvedBusinessTurnContext: null,
  });
  assert.equal(wf.workflowType, "booking_request");
  assert.equal(wf.reason, "explicit_book_phrase_with_item");
});
