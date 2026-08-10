/**
 * Canonical context continuation — Civic unavailable → Corolla select inherits duration.
 * Also covers duration precedence, stale block, and Fix2 canonical consumption.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  buildOfferedAlternativesAssist,
  readFreshLastAvailabilityAssist,
} from "../src/brain/availability/availabilityAssistContext.js";
import {
  resolveCanonicalRentalDuration,
  hasTrustedDurationContinuation,
  resolveBusinessDecisionForPendingContext,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import {
  getEmilySessionState,
  patchEmilySessionState,
} from "../src/services/conversationIntelligence.js";

const BUSINESS_ID = "biz-canonical-ctx";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_fixture";
const SESSION_KEY = `${BUSINESS_ID}::leads::participant::adeel::canonical-ctx`;

function clearSession() {
  patchEmilySessionState(SESSION_KEY, {
    lastAvailabilityAssist: null,
    lastDurationDays: null,
    lastResolvedItemId: null,
    lastItem: null,
    pendingAction: null,
    emilyPending: null,
  });
}

function unavailableCivicCanonical({ durationDays = 3 } = {}) {
  return {
    businessId: BUSINESS_ID,
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      durationDays,
    },
    duration: {
      days: durationDays,
      source: "explicit",
      trustedContinuation: false,
      windowStartAt: "2026-08-10T00:00:00.000Z",
      windowEndAt: "2026-08-13T00:00:00.000Z",
      calendarRelative: null,
    },
    turn: {
      durationDays,
      sourceTurnKey: "turn-civic-a",
      requestedStartAt: "2026-08-10T00:00:00.000Z",
      requestedEndAt: "2026-08-13T00:00:00.000Z",
    },
    participant: { key: "adeel", identity: "stable", memoryAllowed: true },
    sourceIdentity: { participantKey: "adeel" },
    unavailableCustomerReply:
      "Honda Civic 3 din ke liye available nahi hai. Toyota Corolla dekhna chahenge?",
    verified: {
      availability: {
        status: "unavailable",
        isAvailable: false,
        confidentlyUnavailable: true,
        windowApplied: true,
        reason: "booking_conflict",
        requestedStartAt: "2026-08-10T00:00:00.000Z",
        requestedEndAt: "2026-08-13T00:00:00.000Z",
        verifiedAlternatives: [
          { itemId: COROLLA_ID, itemLabel: "Toyota Corolla" },
        ],
      },
    },
    resolvedItem: { id: CIVIC_ID, displayLabel: "Honda Civic", name: "Honda Civic" },
    actions: { availabilityOwnerCheckExecute: true },
  };
}

function availableCorollaCanonical({ durationDays = 3, durationSource = "assist" } = {}) {
  return {
    businessId: BUSINESS_ID,
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      durationDays,
    },
    duration: {
      days: durationDays,
      source: durationSource,
      trustedContinuation: durationSource !== "explicit",
      windowStartAt: "2026-08-10T00:00:00.000Z",
      windowEndAt: "2026-08-13T00:00:00.000Z",
      calendarRelative: null,
    },
    turn: {
      durationDays,
      sourceTurnKey: "turn-corolla-b",
      requestedStartAt: "2026-08-10T00:00:00.000Z",
      requestedEndAt: "2026-08-13T00:00:00.000Z",
    },
    participant: { key: "adeel", identity: "stable", memoryAllowed: true },
    sourceIdentity: { participantKey: "adeel" },
    resolvedItem: {
      id: COROLLA_ID,
      displayLabel: "Toyota Corolla",
      name: "Toyota Corolla",
    },
    verified: {
      availability: {
        status: "available",
        isAvailable: true,
        confidentlyUnavailable: false,
        windowApplied: true,
        reason: "no_blocking_bookings",
        verifiedAlternatives: [],
      },
    },
    actions: {
      allowed: ["AVAILABILITY_OWNER_CHECK_REQUIRED"],
      availabilityOwnerCheckExecute: true,
    },
  };
}

test("CASE1: Civic unavailable + Corolla alt → persist trusted assist duration 3", () => {
  clearSession();
  const plan = buildBookingRequestActionPlan({
    admittedTurn: {
      turn: {
        text: "Civic 3 din k lye kr do",
        businessId: BUSINESS_ID,
        messageId: "wa::civic-a",
      },
    },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
      durationDays: 3,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: unavailableCivicCanonical(),
    },
  });

  assert.equal(plan.actions[0]?.type, "REPLY");
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(plan.persistenceIntent?.rememberLastAvailabilityAssist, true);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.action, "offered_alternatives");
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.unavailableItemId, CIVIC_ID);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.durationDays, 3);
  assert.ok(plan.persistenceIntent?.lastAvailabilityAssist?.expiresAt);

  applySessionMemoryFromActionPlan({
    sessionKey: SESSION_KEY,
    actionPlan: plan,
  });
  const mem = getEmilySessionState(SESSION_KEY);
  const fresh = readFreshLastAvailabilityAssist(mem?.lastAvailabilityAssist);
  assert.ok(fresh);
  assert.equal(fresh.durationDays, 3);
  assert.equal(mem.lastDurationDays, 3);
});

test("CASE1 follow-up: Toyota corolla kr do phr → Fix2 with assist duration 3", () => {
  clearSession();
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC_ID,
    unavailableItemLabel: "Honda Civic",
    durationDays: 3,
    windowStartAt: "2026-08-10T00:00:00.000Z",
    windowEndAt: "2026-08-13T00:00:00.000Z",
    pendingQuestion: "Corolla dekhna chahenge?",
    participantKey: "adeel",
  });
  patchEmilySessionState(SESSION_KEY, {
    lastAvailabilityAssist: assist,
    lastDurationDays: 3,
    lastResolvedItemId: CIVIC_ID,
  });

  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: readFreshLastAvailabilityAssist(assist),
    sessionDurationDays: 3,
    trustedContinuation: true,
  });
  assert.equal(packed.days, 3);
  assert.equal(packed.source, "assist");
  assert.equal(packed.trustedContinuation, true);

  const msg = "Toyota corolla kr do phr";
  const wf = selectWorkflow({
    understanding: {
      resolvedItemId: COROLLA_ID,
      durationDays: null,
      signals: { bookingCommitment: false },
    },
    message: msg,
    turnContext: {
      businessId: BUSINESS_ID,
      memorySnapshot: getEmilySessionState(SESSION_KEY),
    },
    resolvedBusinessTurnContext: {
      decision: { workflowType: "unknown_clarification" },
    },
  });
  // Fresh assist owns follow-up; bare kr do must not invent booking without duration in decision.
  assert.equal(wf.workflowType, "availability_inquiry");

  // When decision is booking_request (canonical booking intent), Fix2 uses packed duration.
  const plan = buildBookingRequestActionPlan({
    admittedTurn: {
      turn: { text: msg, businessId: BUSINESS_ID, messageId: "wa::corolla-b" },
    },
    turnContext: {
      businessId: BUSINESS_ID,
      memorySnapshot: getEmilySessionState(SESSION_KEY),
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      durationDays: null,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: availableCorollaCanonical({
        durationDays: 3,
        durationSource: "assist",
      }),
    },
  });

  assert.equal(plan.workflowType, "booking_request");
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(owner?.payload?.durationDays, 3);
  assert.equal(plan.postExecuteCustomerReply, "owner_check_result");
});

test("duration precedence: explicit overrides assist", () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC_ID,
    durationDays: 3,
  });
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: 5,
    freshAssist: readFreshLastAvailabilityAssist(assist),
    sessionDurationDays: 3,
    trustedContinuation: true,
  });
  assert.equal(packed.days, 5);
  assert.equal(packed.source, "explicit");
  assert.equal(packed.trustedContinuation, false);
});

test("duration precedence: lastDurationDays alone never inherits", () => {
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: null,
    sessionDurationDays: 5,
    trustedContinuation: false,
  });
  assert.equal(packed.days, null);
  assert.equal(packed.source, "none");
  assert.equal(
    hasTrustedDurationContinuation({
      freshAssist: null,
      memorySnapshot: { lastDurationDays: 5 },
      activeAvrDurationDays: null,
    }),
    false
  );
});

test("P1-A: emilyPending.info must NOT unlock lastDurationDays", async () => {
  const { buildEmilyPending } = await import(
    "../src/brain/availability/emilyPendingContext.js"
  );
  const info = buildEmilyPending({
    stage: "info",
    pendingQuestion: "Kya poochna hai?",
    participantKey: "adeel",
  });
  assert.equal(
    hasTrustedDurationContinuation({
      freshAssist: null,
      memorySnapshot: { lastDurationDays: 5, emilyPending: info },
      participantKey: "adeel",
    }),
    false
  );
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: null,
    sessionDurationDays: 5,
    trustedContinuation: hasTrustedDurationContinuation({
      memorySnapshot: { lastDurationDays: 5, emilyPending: info },
      participantKey: "adeel",
    }),
  });
  assert.equal(packed.days, null);
  assert.equal(packed.source, "none");
});

test("P1-B: availability_duration pending does not unlock old session days", async () => {
  const { buildEmilyPending } = await import(
    "../src/brain/availability/emilyPendingContext.js"
  );
  const pending = buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "Kitne din?",
    itemId: COROLLA_ID,
    participantKey: "adeel",
  });
  assert.equal(
    hasTrustedDurationContinuation({
      memorySnapshot: {
        lastDurationDays: 5,
        emilyPending: pending,
        pendingAction: pending,
      },
      participantKey: "adeel",
    }),
    false
  );
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: 3,
    freshAssist: null,
    sessionDurationDays: 5,
    trustedContinuation: false,
  });
  assert.equal(packed.days, 3);
  assert.equal(packed.source, "explicit");
});

test("P1-C: fresh assist duration still trusted", () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC_ID,
    durationDays: 3,
  });
  const fresh = readFreshLastAvailabilityAssist(assist);
  assert.equal(
    hasTrustedDurationContinuation({ freshAssist: fresh }),
    true
  );
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: fresh,
    sessionDurationDays: 9,
    trustedContinuation: true,
  });
  assert.equal(packed.days, 3);
  assert.equal(packed.source, "assist");
});

test("P1-D: active AVR duration still trusted", () => {
  assert.equal(
    hasTrustedDurationContinuation({
      freshAssist: null,
      activeAvrDurationDays: 4,
    }),
    true
  );
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: null,
    activeAvrDurationDays: 4,
    sessionDurationDays: 9,
    trustedContinuation: true,
  });
  assert.equal(packed.days, 4);
  assert.equal(packed.source, "avr");
});

test("P1-E: expired pending / participant mismatch never unlock duration", async () => {
  const { buildEmilyPending } = await import(
    "../src/brain/availability/emilyPendingContext.js"
  );
  const expired = buildEmilyPending({
    stage: "info",
    pendingQuestion: "q",
    participantKey: "adeel",
    ttlMs: 1,
  });
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(
    hasTrustedDurationContinuation({
      memorySnapshot: { lastDurationDays: 5, emilyPending: expired },
      participantKey: "adeel",
    }),
    false
  );
  const foreign = buildEmilyPending({
    stage: "info",
    pendingQuestion: "q",
    participantKey: "other",
  });
  assert.equal(
    hasTrustedDurationContinuation({
      memorySnapshot: { lastDurationDays: 5, emilyPending: foreign },
      participantKey: "adeel",
    }),
    false
  );
});

test("duration precedence: gated session only when caller already has trusted owner", () => {
  const packed = resolveCanonicalRentalDuration({
    explicitDurationDays: null,
    freshAssist: null,
    activeAvrDurationDays: null,
    sessionDurationDays: 3,
    trustedContinuation: true,
  });
  assert.equal(packed.days, 3);
  assert.equal(packed.source, "gated_session");
});

test("CASE: both override — Stonic 5din explicit wins", () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: {
      turn: { text: "Stonic 5 din k lye kr do", businessId: BUSINESS_ID },
    },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      durationDays: 5,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        ...availableCorollaCanonical({ durationDays: 5, durationSource: "explicit" }),
        resolvedItem: { id: STONIC_ID, displayLabel: "Kia Stonic", name: "Kia Stonic" },
        decision: {
          workflowType: "booking_request",
          durationDays: 5,
        },
      },
    },
  });
  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(owner?.payload?.itemId, STONIC_ID);
  assert.equal(owner?.payload?.durationDays, 5);
});

test("CASE: cold kr do — no invent duration / no AVR", () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "kr do", businessId: BUSINESS_ID } },
    turnContext: { businessId: BUSINESS_ID, memorySnapshot: {} },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      durationDays: null,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        decision: { workflowType: "booking_request", durationDays: null },
        duration: {
          days: null,
          source: "none",
          trustedContinuation: false,
          windowStartAt: null,
          windowEndAt: null,
          calendarRelative: null,
        },
        turn: { durationDays: null },
        resolvedItem: { id: COROLLA_ID, displayLabel: "Toyota Corolla" },
        verified: {
          availability: {
            isAvailable: true,
            confidentlyUnavailable: false,
            verifiedAlternatives: [],
          },
        },
        actions: { availabilityOwnerCheckExecute: true },
      },
    },
  });
  assert.equal(plan.actions[0]?.type, "NO_OP");
  assert.equal(plan.actions[0]?.payload?.intentionallySilent, true);
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("CASE: Fix1 no alts → no assist", () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: {
      turn: { text: "Civic 3 din k lye kr do", businessId: BUSINESS_ID },
    },
    turnContext: { businessId: BUSINESS_ID },
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
      durationDays: 3,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        ...unavailableCivicCanonical(),
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            confidentlyUnavailable: true,
            windowApplied: true,
            verifiedAlternatives: [],
          },
        },
        unavailableCustomerReply:
          "Honda Civic 3 din ke liye available nahi hai. Filhal koi dusri car available nahi hai.",
      },
    },
  });
  assert.equal(plan.persistenceIntent?.rememberLastAvailabilityAssist, false);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist, null);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.equal(plan.actions.some((a) => a.type === "CREATE_BOOKING"), false);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("decision.durationDays matches canonical duration days", () => {
  const decision = resolveBusinessDecisionForPendingContext({
    normalizedMessage: "toyota corolla kr do phr",
    understanding: { durationDays: null, resolvedItemId: COROLLA_ID },
    signals: { bookingCommitment: true, strongBookingCommitment: false },
    itemFacts: { id: COROLLA_ID, label: "Toyota Corolla" },
    participantFacts: { participant: { memoryAllowed: true } },
    canonicalDurationDays: 3,
  });
  assert.equal(decision.durationDays, 3);
  assert.equal(decision.workflowType, "booking_request");
});

test("clear assist also clears lastDurationDays when not re-remembered", () => {
  clearSession();
  patchEmilySessionState(SESSION_KEY, {
    lastAvailabilityAssist: buildOfferedAlternativesAssist({
      unavailableItemId: CIVIC_ID,
      durationDays: 3,
    }),
    lastDurationDays: 3,
  });
  applySessionMemoryFromActionPlan({
    sessionKey: SESSION_KEY,
    actionPlan: {
      planId: randomUUID(),
      persistenceIntent: {
        clearLastAvailabilityAssist: true,
        execute: false,
      },
    },
  });
  const mem = getEmilySessionState(SESSION_KEY);
  assert.equal(mem.lastAvailabilityAssist, null);
  assert.equal(mem.lastDurationDays, null);
});
