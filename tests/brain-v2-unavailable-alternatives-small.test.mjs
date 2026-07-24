/**
 * Brain V2 — unavailable inventory + Brain-owned alternatives follow-up (Option C).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildAvailabilityInquiryActionPlan,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  buildOfferedAlternativesAssist,
  AVAILABILITY_ASSIST_TTL_MS,
} from "../src/brain/availability/availabilityAssistContext.js";
import {
  decideAvailabilityAssistFollowUp,
  resolveAvailabilityAssistFollowUpDecision,
  gateAvailabilityAssistFollowUpDecision,
} from "../src/brain/availability/decideAvailabilityAssistFollowUp.js";
import {
  isConfidentInventoryUnavailable,
  resolveItemBookingAwareAvailability,
} from "../src/brain/facts/resolveItemBookingAwareAvailability.js";
import { resolveBookingDateWindowFromDuration } from "../src/brain/facts/resolveBookingDateWindow.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";

const BUSINESS_ID = "biz-unavailable-alts";
const COROLLA_ID = "toyota_corolla_grey";
const STONIC_ID = "kia_stonic";
const CIVIC_ID = "honda_civic";

function admitted(text) {
  return {
    turn: {
      turnId: "t1",
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "group-1",
      participantKey: "cust-1",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "t1",
    admissionReason: "test",
  };
}

function understanding(overrides = {}) {
  return {
    resolvedItemId: COROLLA_ID,
    resolvedItemLabel: "Toyota Corolla (Metallic Grey)",
    itemSource: "explicit",
    durationDays: 2,
    askedField: "availability",
    intentsRanked: ["availability_check"],
    signals: { availabilityAsk: true },
    ...overrides,
  };
}

function unavailableAvailability(overrides = {}) {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  return {
    status: "unavailable",
    isAvailable: false,
    reason: "booking_conflict",
    windowApplied: true,
    dateWindowConfidence: "duration_default_now",
    requestedStartAt: window?.startAt.toISOString() ?? null,
    requestedEndAt: window?.endAt.toISOString() ?? null,
    verifiedAlternatives: [
      { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
      { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
    ],
    ...overrides,
  };
}

function canonicalContext(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    resolvedItem: {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla (Metallic Grey)",
    },
    turn: {
      durationDays: 2,
      sourceMessageId: "m1",
      sourceRowKey: "r1",
      guaranteeKey: "g1",
      sourceTurnKey: "g1",
    },
    verified: {
      availability: unavailableAvailability(),
      priceQuote: null,
    },
    actions: { availabilityOwnerCheckExecute: false },
    participant: { key: "cust-1" },
    sourceIdentity: { chatId: "group-1", chatType: "group", participantKey: "cust-1" },
    lastAvailabilityAssist: null,
    ...overrides,
  };
}

function planWithBrain(message, brainDecision, ctxOverrides = {}, understandingOverrides = {}) {
  const assist =
    ctxOverrides.lastAvailabilityAssist !== undefined
      ? ctxOverrides.lastAvailabilityAssist
      : buildOfferedAlternativesAssist({
          unavailableItemId: COROLLA_ID,
          unavailableItemLabel: "Toyota Corolla",
          durationDays: 2,
        });
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted(message),
    understanding: understanding(understandingOverrides),
    catalogItems: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
    ],
    businessContext: {
      resolvedBusinessTurnContext: canonicalContext({
        lastAvailabilityAssist: assist,
        verified: {
          availability: unavailableAvailability(),
          priceQuote: null,
        },
        ...ctxOverrides,
        lastAvailabilityAssist: assist,
      }),
      __availabilityAssistFollowUpDecision: brainDecision,
    },
  });
}

test("1: unavailable requested item → reply-only offer, no owner-check", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Corolla 2 din k lye available hai?"),
    understanding: understanding(),
    catalogItems: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla (Metallic Grey)" },
    ],
    businessContext: { resolvedBusinessTurnContext: canonicalContext() },
  });

  assert.match(String(plan.replyDraft ?? ""), /available nahi hai/i);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(plan.actions[0]?.payload?.source, "canonical_unavailable_alternative_offer");
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.action, "offered_alternatives");
  assert.ok(AVAILABILITY_ASSIST_TTL_MS <= 15 * 60 * 1000);
});

test("2: available requested item → existing owner-check unchanged", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Corolla 2 din ke liye available hai?"),
    understanding: understanding(),
    catalogItems: [{ id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" }],
    businessContext: {
      resolvedBusinessTurnContext: canonicalContext({
        verified: {
          availability: {
            status: "available",
            isAvailable: true,
            reason: "no_blocking_bookings",
            windowApplied: true,
            verifiedAlternatives: [],
          },
          priceQuote: null,
        },
      }),
    },
  });

  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner);
  assert.equal(owner.payload.itemId, COROLLA_ID);
});

test("3: unknown/error inventory does not falsely claim unavailable", () => {
  assert.equal(
    isConfidentInventoryUnavailable({
      status: "error",
      isAvailable: null,
      windowApplied: false,
      reason: "booking_query_error",
    }),
    false
  );
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Corolla 2 din ke liye available hai?"),
    understanding: understanding(),
    catalogItems: [{ id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" }],
    businessContext: {
      resolvedBusinessTurnContext: canonicalContext({
        verified: {
          availability: {
            status: "error",
            isAvailable: null,
            windowApplied: false,
            reason: "booking_query_error",
            verifiedAlternatives: [],
          },
          priceQuote: null,
        },
      }),
    },
  });
  assert.ok(plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"));
});

test("4: after offer + ji + injected accept → verified alternatives", async () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const brain = await decideAvailabilityAssistFollowUp({
    customerText: "ji",
    lastAvailabilityAssist: assist,
    verifiedAlternatives: [
      { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
      { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
    ],
    __decisionForTests: {
      decision: "accept_alternative_offer",
      confidence: 0.92,
      shouldClearAssist: false,
      reason: "test_accept",
    },
  });
  assert.equal(brain.decision, "accept_alternative_offer");

  const plan = planWithBrain("ji", brain, {}, {
    resolvedItemId: null,
    signals: {},
    durationDays: null,
    askedField: null,
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
  assert.match(String(plan.replyDraft ?? ""), /Stonic/i);
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("5: after offer + thanks + injected unrelated → no alts + clear", async () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const brain = await decideAvailabilityAssistFollowUp({
    customerText: "thanks",
    lastAvailabilityAssist: assist,
    __decisionForTests: {
      decision: "unrelated_message",
      confidence: 0.95,
      shouldClearAssist: true,
      reason: "closing_thanks",
    },
  });
  const plan = planWithBrain("thanks", brain, {}, {
    resolvedItemId: null,
    signals: {},
    durationDays: null,
  });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Stonic|Civic|options/i);
});

test("6: after offer + done + injected unclear → no alts", async () => {
  const brain = {
    decision: "unclear",
    confidence: 0.4,
    shouldClearAssist: true,
    ok: true,
  };
  // low confidence gates to unclear fallback
  const gated = gateAvailabilityAssistFollowUpDecision({
    decision: "unclear",
    confidence: 0.9,
    shouldClearAssist: true,
    ok: true,
  });
  assert.equal(gated.decision, "unclear");

  const plan = planWithBrain("done", brain, {}, {
    resolvedItemId: null,
    signals: {},
    durationDays: null,
  });
  assert.equal(
    plan.actions.some((a) => a.type === "REPLY" && /Stonic|options/i.test(String(a.payload?.text))),
    false
  );
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("7: ji without offer context → no alternatives", () => {
  const decision = resolveAvailabilityAssistFollowUpDecision({
    lastAvailabilityAssist: null,
    brainDecision: {
      decision: "accept_alternative_offer",
      confidence: 0.99,
      ok: true,
    },
  });
  assert.equal(decision.decision, "unrelated_message");

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("ji"),
    understanding: understanding({
      resolvedItemId: null,
      signals: {},
      durationDays: null,
    }),
    catalogItems: [],
    businessContext: {
      resolvedBusinessTurnContext: canonicalContext({ lastAvailabilityAssist: null }),
      __availabilityAssistFollowUpDecision: {
        decision: "accept_alternative_offer",
        confidence: 0.99,
        ok: true,
      },
    },
  });
  assert.notEqual(plan.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
});

test("8: explicit ask + injected ask_available → verified alternatives", () => {
  const plan = planWithBrain(
    "or kon c options available hain",
    {
      decision: "ask_available_alternatives",
      confidence: 0.91,
      ok: true,
    },
    {},
    {
      resolvedItemId: null,
      signals: { browseAsk: true },
      durationDays: null,
    }
  );
  assert.match(String(plan.replyDraft ?? ""), /Stonic/i);
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
});

test("9: selected available Stonic + injected select → owner-check", () => {
  const plan = planWithBrain(
    "Stonic",
    {
      decision: "select_alternative_item",
      confidence: 0.93,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    {
      resolvedItem: { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      turn: { durationDays: 2 },
      verified: {
        availability: {
          status: "available",
          isAvailable: true,
          windowApplied: true,
          verifiedAlternatives: [{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }],
        },
      },
    },
    {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      signals: {},
      durationDays: null,
    }
  );
  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner);
  assert.equal(owner.payload.itemId, STONIC_ID);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("10: selected unavailable alternative → no AVR", () => {
  const plan = planWithBrain(
    "Stonic",
    {
      decision: "select_alternative_item",
      confidence: 0.9,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    {
      verified: {
        availability: {
          status: "unavailable",
          isAvailable: false,
          windowApplied: true,
          verifiedAlternatives: [{ itemId: CIVIC_ID, itemLabel: "Honda Civic" }],
        },
      },
    },
    { resolvedItemId: STONIC_ID, signals: {}, durationDays: null }
  );
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.match(String(plan.replyDraft ?? ""), /Civic/i);
});

test("11: Brain helper failure + short text → no unsafe alternatives", async () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const brain = await decideAvailabilityAssistFollowUp({
    customerText: "ok",
    lastAvailabilityAssist: assist,
    __chatCompletionsCreateForTests: async () => {
      throw new Error("OPENAI_DOWN");
    },
  });
  assert.equal(brain.decision, "unclear");
  assert.equal(brain.shouldClearAssist, true);
  assert.equal(brain.ok, false);

  const plan = planWithBrain("ok", brain, {}, {
    resolvedItemId: null,
    signals: {},
    durationDays: null,
  });
  assert.equal(plan.actions.length, 0);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Stonic|Civic/i);
});

test("12: heuristic short-accept no longer decides meaning", () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  // No brain decision → fail-safe unclear, not accept
  const followUp = resolveAvailabilityAssistFollowUpDecision({
    lastAvailabilityAssist: assist,
    brainDecision: null,
    understanding: { signals: {} },
  });
  assert.equal(followUp.decision, "unclear");
  assert.notEqual(followUp.decision, "accept_alternative_offer");
});

test("13: window-aligned overlapping booking → confident unavailable", async () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const result = await resolveItemBookingAwareAvailability({
    businessId: BUSINESS_ID,
    itemId: COROLLA_ID,
    itemName: "Toyota Corolla",
    wantsAvailability: true,
    durationDays: 2,
    nowMs: now,
    getBookingsForItemFn: async () => [
      {
        id: "aBIaLZqRpWJSEsylUqaT",
        itemId: COROLLA_ID,
        status: "approved",
        startAt: new Date("2026-07-22T00:00:00.000Z"),
        endAt: new Date("2026-07-26T00:00:00.000Z"),
      },
    ],
  });
  assert.equal(isConfidentInventoryUnavailable(result.availability), true);
});

test("14: WorkflowEngine routes fresh assist without short-accept heuristic", () => {
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const wf = selectWorkflow({
    understanding: {
      resolvedItemId: null,
      signals: {},
      intentsRanked: [],
    },
    turnContext: {
      sessionId: "s",
      businessId: BUSINESS_ID,
      chatKey: "g",
      participantKey: "c",
      schemaVersion: 1,
      memorySnapshot: { lastAvailabilityAssist: assist },
    },
    message: "thanks",
  });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.equal(wf.reason, "availability_assist_follow_up_pending");
});
