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
  readFreshLastAvailabilityAssist,
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
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  ONBOARDING_CLARIFICATION_REPLY,
  isOnboardingStyleClarificationReply,
} from "../src/brain/live/shouldSuppressPostConfirmOnboardingClarification.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { loadBrainV2SessionMemorySnapshot } from "../src/services/whatsappInboundBuffer.js";
import { resolveShadowEmilySessionKey } from "../src/brain/shadow/brainShadowHook.js";
import { findVerifiedAvailabilityAlternatives } from "../src/services/availabilityRejectionAlternatives.js";
import { computeUserFacingAvailability } from "../src/services/inventoryService.js";

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
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.pendingQuestion,
    plan.replyDraft
  );
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.pendingPromptType,
    "offer_to_list_alternatives"
  );
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.assistStage,
    "awaiting_alternative_offer_response"
  );
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
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.type, "NO_OP");
  assert.equal(plan.actions[0]?.payload?.intentionallySilent, true);
  assert.equal(plan.actions[0]?.payload?.source, "availability_assist_context_no_reply");
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Stonic|Civic|options|Main samajh nahi paaya/i);
});

test("6: after offer + done + injected unclear → explicit no-reply, no alts", async () => {
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
  assert.equal(plan.actions[0]?.type, "NO_OP");
  assert.equal(plan.actions[0]?.payload?.intentionallySilent, true);
  assert.equal(
    plan.actions.some((a) => a.type === "REPLY" && /Stonic|options/i.test(String(a.payload?.text))),
    false
  );
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Main samajh nahi paaya/i);
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
  assert.equal(plan.actions[0]?.type, "NO_OP");
  assert.equal(plan.actions[0]?.payload?.intentionallySilent, true);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Stonic|Civic|Main samajh nahi paaya/i);
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

function enableV2Live() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
}

test("15A: live pipeline — fresh assist + unclear NO_OP → silence, not onboarding clarify", async () => {
  enableV2Live();
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const plan = planWithBrain(
    "jii",
    {
      decision: "unclear",
      confidence: 0.2,
      shouldClearAssist: true,
      ok: false,
    },
    {},
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.equal(plan.actions[0]?.type, "NO_OP");

  const result = await runBrainV2LivePipeline({
    traceId: "assist-unclear-silence",
    businessId: BUSINESS_ID,
    message: "jii",
    catalogItems: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
    ],
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    sessionKey: "group-assist-unclear",
    memorySnapshot: { lastAvailabilityAssist: assist },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan: plan,
      understanding: { signals: {} },
      trace: {},
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.reason, "ASSIST_CONTEXT_NO_REPLY");
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.equal(result.sendVia, "NONE");
  assert.doesNotMatch(String(result.reply ?? ""), /Main samajh nahi paaya/i);
  assert.notEqual(result.reply, ONBOARDING_CLARIFICATION_REPLY);
  assert.equal(
    result.actionPlan?.actions?.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    undefined
  );
});

test("15B: live pipeline — helper fail unclear → no onboarding, no AVR", async () => {
  enableV2Live();
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const brain = await decideAvailabilityAssistFollowUp({
    customerText: "jii",
    lastAvailabilityAssist: assist,
    __chatCompletionsCreateForTests: async () => {
      throw new Error("OPENAI_DOWN");
    },
  });
  const plan = planWithBrain("jii", brain, {}, {
    resolvedItemId: null,
    signals: {},
    durationDays: null,
  });
  assert.equal(plan.actions[0]?.type, "NO_OP");

  const result = await runBrainV2LivePipeline({
    traceId: "assist-helper-fail",
    businessId: BUSINESS_ID,
    message: "jii",
    catalogItems: [{ id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" }],
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    memorySnapshot: { lastAvailabilityAssist: assist },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan: plan,
      understanding: { signals: {} },
      trace: {},
    }),
  });
  assert.equal(result.reason, "ASSIST_CONTEXT_NO_REPLY");
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.doesNotMatch(String(result.reply ?? ""), /Main samajh nahi paaya|Stonic/i);
});

test("15C: live pipeline — forced empty plan + fresh assist → silence not SAFE_CLARIFICATION", async () => {
  enableV2Live();
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
  });
  const result = await runBrainV2LivePipeline({
    traceId: "assist-empty-guard",
    businessId: BUSINESS_ID,
    message: "jii",
    catalogItems: [{ id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" }],
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-assist-empty",
    sessionKey: "group-assist-empty",
    memorySnapshot: { lastAvailabilityAssist: assist },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan: {
        planId: "forced-empty",
        replyDraft: undefined,
        actions: [],
      },
      understanding: { signals: {} },
      trace: {},
    }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "ASSIST_CONTEXT_NO_REPLY");
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.equal(result.sendVia, "NONE");
  assert.notEqual(result.reply, ONBOARDING_CLARIFICATION_REPLY);
});

test("15D: live pipeline — no assist + unknown short message → onboarding clarification unchanged", async () => {
  enableV2Live();
  const result = await runBrainV2LivePipeline({
    traceId: "no-assist-clarify",
    businessId: BUSINESS_ID,
    message: "asdfqwer",
    catalogItems: [{ id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" }],
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-no-assist",
    memorySnapshot: {},
  });
  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Main samajh nahi paaya/i);
  assert.equal(isOnboardingStyleClarificationReply(result.reply), true);
});

test("15E: fresh assist + injected accept → verified alternatives listed", () => {
  const plan = planWithBrain(
    "jii",
    {
      decision: "accept_alternative_offer",
      confidence: 0.92,
      ok: true,
    },
    {},
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.match(String(plan.replyDraft ?? ""), /Stonic/i);
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("15F: fresh assist + selected Stonic → owner-check", () => {
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
          verifiedAlternatives: [
            { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
            { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
          ],
        },
        priceQuote: null,
      },
    },
    {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      signals: {},
      durationDays: 2,
    }
  );
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(
    plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED")?.payload?.itemId,
    STONIC_ID
  );
});

test("16: session-memory round-trip — offer persist → same key load → assist route → accept alts", async () => {
  const groupSessionKey = "group-assist-roundtrip";
  const participantKey = "cust-assist-rt-1";
  const playwrightChatKey = "group-assist-roundtrip";
  const memoryParams = {
    businessId: BUSINESS_ID,
    ownerUserId: BUSINESS_ID,
    sessionKey: groupSessionKey,
    participantKey,
    playwrightChatKey,
    isGroupInbound: true,
  };
  const emilySessionKey = resolveShadowEmilySessionKey(memoryParams);
  assert.ok(emilySessionKey);

  const offerPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Corolla 2 din k lye available hai? smoke42unavail001"),
    understanding: understanding(),
    catalogItems: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
    ],
    businessContext: { resolvedBusinessTurnContext: canonicalContext() },
  });

  assert.equal(offerPlan.persistenceIntent?.rememberLastAvailabilityAssist, true);
  assert.equal(
    offerPlan.persistenceIntent?.lastAvailabilityAssist?.action,
    "offered_alternatives"
  );
  assert.equal(
    offerPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );

  applySessionMemoryFromActionPlan({
    sessionKey: emilySessionKey,
    actionPlan: offerPlan,
  });

  const loaded = await loadBrainV2SessionMemorySnapshot({
    ...memoryParams,
    traceId: "assist-rt-load",
  });
  const freshAssist = readFreshLastAvailabilityAssist(loaded?.lastAvailabilityAssist);
  assert.ok(freshAssist, "same-key load must return fresh lastAvailabilityAssist");
  assert.equal(freshAssist.action, "offered_alternatives");
  assert.equal(freshAssist.unavailableItemId, COROLLA_ID);

  const wf = selectWorkflow({
    understanding: {
      resolvedItemId: null,
      signals: {},
      intentsRanked: [],
    },
    turnContext: {
      sessionId: emilySessionKey,
      businessId: BUSINESS_ID,
      chatKey: playwrightChatKey,
      participantKey,
      schemaVersion: 1,
      memorySnapshot: loaded,
    },
    message: "jii",
  });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.equal(wf.reason, "availability_assist_follow_up_pending");

  const acceptPlan = planWithBrain(
    "jii",
    {
      decision: "accept_alternative_offer",
      confidence: 0.95,
      ok: true,
    },
    { lastAvailabilityAssist: freshAssist },
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.match(String(acceptPlan.replyDraft ?? ""), /Stonic|Civic|options/i);
  assert.equal(
    acceptPlan.actions[0]?.payload?.source,
    "canonical_verified_alternatives_list"
  );
  assert.equal(
    acceptPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.doesNotMatch(
    String(acceptPlan.replyDraft ?? ""),
    /Main samajh nahi paaya/i
  );
  assert.notEqual(acceptPlan.replyDraft, ONBOARDING_CLARIFICATION_REPLY);

  // Negative control: wrong participant key → no assist → no assist follow-up route
  const wrongParams = {
    ...memoryParams,
    participantKey: "cust-assist-rt-OTHER",
  };
  const wrongLoaded = await loadBrainV2SessionMemorySnapshot({
    ...wrongParams,
    traceId: "assist-rt-wrong-key",
  });
  assert.equal(
    readFreshLastAvailabilityAssist(wrongLoaded?.lastAvailabilityAssist),
    null
  );
  const wfWrong = selectWorkflow({
    understanding: {
      resolvedItemId: null,
      signals: {},
      intentsRanked: [],
    },
    turnContext: {
      sessionId: resolveShadowEmilySessionKey(wrongParams),
      businessId: BUSINESS_ID,
      chatKey: playwrightChatKey,
      participantKey: wrongParams.participantKey,
      schemaVersion: 1,
      memorySnapshot: wrongLoaded ?? {},
    },
    message: "jii",
  });
  assert.notEqual(wfWrong.reason, "availability_assist_follow_up_pending");
  assert.equal(wfWrong.workflowType, "unknown_clarification");
});

test("17: booking-based alts — Corolla booked, Civic/Stonic free → both listed (no similarity filter)", async () => {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  const catalog = [
    {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla (Metallic Grey)",
    },
    { id: CIVIC_ID, name: "Honda Civic 2026 Oriel", displayLabel: "Honda Civic 2026 Oriel (White)" },
    {
      id: STONIC_ID,
      name: "Kia Stonic EX Plus 2021",
      displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
    },
  ];
  const bookingsByItem = {
    [COROLLA_ID]: [
      {
        id: "bk-corolla",
        itemId: COROLLA_ID,
        status: "approved",
        startAt: new Date("2026-07-22T00:00:00.000Z"),
        endAt: new Date("2026-07-28T00:00:00.000Z"),
      },
    ],
    [CIVIC_ID]: [],
    [STONIC_ID]: [],
  };

  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    referenceItemLabel: "Toyota Corolla (Metallic Grey)",
    limit: 3,
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
    catalogRows: catalog,
    getBookingsForItemFn: async (_uid, itemId) => bookingsByItem[itemId] ?? [],
  });

  const ids = alts.map((a) => a.itemId);
  assert.ok(ids.includes(CIVIC_ID), "Civic must be eligible despite low name similarity");
  assert.ok(ids.includes(STONIC_ID), "Stonic must be eligible despite low name similarity");
  assert.equal(ids.includes(COROLLA_ID), false);

  const acceptPlan = planWithBrain(
    "yes",
    {
      decision: "accept_alternative_offer",
      confidence: 0.95,
      ok: true,
    },
    {
      lastAvailabilityAssist: buildOfferedAlternativesAssist({
        unavailableItemId: COROLLA_ID,
        unavailableItemLabel: "Toyota Corolla",
        durationDays: 2,
        windowStartAt: window.startAt,
        windowEndAt: window.endAt,
      }),
      verified: {
        availability: {
          ...unavailableAvailability(),
          verifiedAlternatives: alts,
        },
        priceQuote: null,
      },
    },
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.match(String(acceptPlan.replyDraft ?? ""), /Civic|Stonic/i);
  assert.doesNotMatch(String(acceptPlan.replyDraft ?? ""), /Sorry abi koi option available nahi hai/i);
  assert.equal(
    acceptPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("18: booking-based alts — all others booked → empty list", async () => {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  const conflict = {
    status: "approved",
    startAt: new Date("2026-07-22T00:00:00.000Z"),
    endAt: new Date("2026-07-28T00:00:00.000Z"),
  };
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    referenceItemLabel: "Toyota Corolla",
    limit: 3,
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
    catalogRows: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
    ],
    getBookingsForItemFn: async (_uid, itemId) => [
      { id: `bk-${itemId}`, itemId, ...conflict },
    ],
  });
  assert.equal(alts.length, 0);

  const plan = planWithBrain(
    "yes",
    { decision: "accept_alternative_offer", confidence: 0.95, ok: true },
    {
      verified: {
        availability: unavailableAvailability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.match(String(plan.replyDraft ?? ""), /Sorry abi koi option available nahi hai/i);
  assert.equal(plan.actions[0]?.payload?.source, "canonical_unavailable_no_alternatives");
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
});

test("19: booking-based alts — exclude requested + exclude booked candidate", async () => {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    referenceItemLabel: "Toyota Corolla",
    limit: 5,
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
    catalogRows: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
    ],
    getBookingsForItemFn: async (_uid, itemId) => {
      if (itemId === STONIC_ID) {
        return [
          {
            id: "bk-stonic",
            itemId: STONIC_ID,
            status: "approved",
            startAt: new Date("2026-07-22T00:00:00.000Z"),
            endAt: new Date("2026-07-28T00:00:00.000Z"),
          },
        ];
      }
      return [];
    },
  });
  const ids = alts.map((a) => a.itemId);
  assert.equal(ids.includes(COROLLA_ID), false);
  assert.equal(ids.includes(STONIC_ID), false);
  assert.ok(ids.includes(CIVIC_ID));
});

test("20: AVR is not an availability input — empty bookings ⇒ candidate available", async () => {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  let sawAvrArg = false;
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    referenceItemLabel: "Toyota Corolla",
    limit: 3,
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
    catalogRows: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
    ],
    getBookingsForItemFn: async () => {
      // Simulate: AVR may exist in Firestore, but finder only receives bookings.
      sawAvrArg = false;
      return [];
    },
  });
  assert.equal(sawAvrArg, false);
  assert.ok(alts.some((a) => a.itemId === CIVIC_ID));
  const av = computeUserFacingAvailability([], CIVIC_ID, {
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
  });
  assert.equal(av.isAvailable, true);
});

test("21: listing alternatives creates no owner-check / AVR action", () => {
  const plan = planWithBrain(
    "yes",
    { decision: "accept_alternative_offer", confidence: 0.94, ok: true },
    {
      verified: {
        availability: unavailableAvailability({
          verifiedAlternatives: [
            { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
            { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
          ],
        }),
        priceQuote: null,
      },
    },
    { resolvedItemId: null, signals: {}, durationDays: null }
  );
  assert.equal(plan.actions[0]?.type, "REPLY");
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING" || a.type === "NOTIFY_OWNER"),
    false
  );
});
