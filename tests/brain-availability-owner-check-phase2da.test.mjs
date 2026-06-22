/**
 * Phase 2D-A — availability owner-check action planning without side effects.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";
process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = "false";

import {
  buildAvailabilityInquiryActionPlan,
  buildAskDurationAvailabilityReply,
  buildOwnerCheckDeferralReply,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { routeLiveActionPlan } from "../src/brain/live/actionRouter.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { understandTurn } from "../src/brain/understanding/UnderstandingEngine.js";
import { buildShadowTurnContext } from "../src/brain/shadow/brainShadowHook.js";
import { evaluateInboundAdmissionContract } from "../src/brain/admission/admissionContract.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { getEmilyBrainV2LiveFlagSnapshot } from "../src/brain/config/liveFeatureFlags.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const fixture = loadSyntheticCarRentalCatalogFixture();
const flags = getEmilyBrainV2LiveFlagSnapshot();

function enableV2LiveEnv() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE = "false";
}

function makeAdmittedTurn(message) {
  return {
    turn: {
      turnId: "phase2da-turn",
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "car-rental-queries",
      participantKey: "cust-1",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "phase2da::turn",
    admissionReason: "test",
  };
}

function canonicalBusinessContext(overrides = {}) {
  return {
    resolvedBusinessTurnContext: Object.freeze({
      businessId: BUSINESS_ID,
      resolvedItem: Object.freeze({
        id: CIVIC_ID,
        name: "Honda Civic 2026 Oriel",
        displayLabel: "Honda Civic 2026 Oriel (White)",
        status: "resolved",
      }),
      turn: Object.freeze({
        durationDays: overrides.durationDays ?? null,
      }),
      participant: Object.freeze({
        key: "cust-1",
        identity: "stable",
        memoryAllowed: true,
      }),
      verified: Object.freeze({
        availability: Object.freeze({
          status: "available",
          isAvailable: true,
          source: "computeUserFacingAvailability",
          bookingAware: true,
          blockingBookingCount: 0,
        }),
        priceQuote: Object.freeze({
          status: "not_requested",
          durationDays: null,
          total: null,
          currency: "PKR",
        }),
      }),
      actions: Object.freeze({
        bookingExecute: false,
        ownerExecute: false,
        dmExecute: false,
        blocked: ["CREATE_BOOKING", "NOTIFY_OWNER", "DM_CUSTOMER", "HANDOFF_DM", "SEND_IMAGES"],
      }),
      forbiddenClaims: Object.freeze(["booking_created", "owner_notified", "dm_sent", "image_sent"]),
      replyConstraints: Object.freeze({
        mustNotInventPrice: true,
        mustNotInventAvailability: true,
        mustNotClaimBlockedActions: true,
      }),
      ...overrides.contextExtras,
    }),
  };
}

test("1: Civic available? asks duration and creates no owner action", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic available?"),
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
      itemSource: "explicit",
      askedField: "availability",
      signals: { availabilityAsk: true },
    },
    catalogItems: fixture.items,
    businessContext: canonicalBusinessContext(),
  });

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.type, "REPLY");
  assert.equal(
    plan.replyDraft,
    "Civic ka mai check kar leta hun. Kitne din ke liye chahiye?"
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Available hai/i);
  assert.ok(!plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"));
});

test("2: Civic 3 din ke liye available hai? creates AVAILABILITY_OWNER_CHECK_REQUIRED", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic 3 din ke liye available hai?"),
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
      itemSource: "explicit",
      askedField: "availability",
      durationDays: 3,
      signals: { availabilityAsk: true },
    },
    catalogItems: fixture.items,
    businessContext: canonicalBusinessContext({ durationDays: 3 }),
  });

  const ownerAction = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload.execute, false);
  assert.equal(ownerAction.payload.itemId, CIVIC_ID);
  assert.equal(ownerAction.payload.durationDays, 3);
  assert.equal(ownerAction.payload.canonicalAvailability?.status, "available");
  assert.equal(
    plan.replyDraft,
    "Civic 3 din ke liye mai confirm kar leta hun."
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Available hai/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Check DM/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /owner ko bhej/i);
});

test("3: action router blocks owner-check side effect while flag is false", () => {
  const routed = routeLiveActionPlan(
    {
      planId: "phase2da-plan",
      replyDraft: "Civic 3 din ke liye mai confirm kar leta hun.",
      actions: [
        { type: "REPLY", payload: { text: "Civic 3 din ke liye mai confirm kar leta hun.", execute: false } },
        {
          type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
          payload: { itemId: CIVIC_ID, durationDays: 3, execute: false },
        },
      ],
    },
    flags
  );

  assert.ok(routed.blockedSideEffects.includes("AVAILABILITY_OWNER_CHECK_REQUIRED"));
  const ownerAction = routed.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(ownerAction?.allowed, false);
  assert.equal(ownerAction?.execute, false);
});

test("4: availability + duration routes to availability_inquiry not pricing or booking", () => {
  const message = "Civic 3 din ke liye available hai?";
  const admission = evaluateInboundAdmissionContract({
    text: message,
    chatKey: "car-rental-queries",
    businessId: BUSINESS_ID,
    participantKey: "cust-1",
    channelId: "whatsapp_web",
    turnId: "t1",
  });
  const turnContext = buildShadowTurnContext({
    businessId: BUSINESS_ID,
    participantKey: "cust-1",
    playwrightChatKey: "car-rental-queries",
    isGroupInbound: true,
    memorySnapshot: {},
  });
  const understanding = understandTurn({
    admittedTurn: admission.admittedTurn,
    turnContext,
    catalogItems: fixture.items,
  });
  const wf = selectWorkflow({ understanding, turnContext, message });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.notEqual(wf.workflowType, "pricing_with_duration");
  assert.notEqual(wf.workflowType, "booking_request");
});

test("5: live pipeline — Civic available? asks duration with no side effects", async () => {
  enableV2LiveEnv();

  const result = await runBrainV2LivePipeline({
    traceId: "phase2da-live-ask-duration",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });

  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Available hai/i);
  assert.equal(result.legacyBypassed, true);
  assert.equal(result.messageMeta?.bookingCreated, undefined);
  assert.ok(
    !(result.messageMeta?.actionPlan?.actions ?? []).some(
      (a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"
    )
  );
});

test("6: live pipeline — duration availability creates owner-check action execute false", async () => {
  enableV2LiveEnv();

  const result = await runBrainV2LivePipeline({
    traceId: "phase2da-live-owner-check",
    businessId: BUSINESS_ID,
    message: "Civic 3 din ke liye available hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });

  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /mai confirm kar leta hun/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Available hai/i);
  const actions = result.messageMeta?.actionPlan?.actions ?? [];
  const ownerAction = actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerAction);
  assert.equal(ownerAction.payload.execute, false);
  assert.equal(result.legacyBypassed, true);
  assert.equal(result.messageMeta?.bookingCreated, undefined);
  assert.ok(
    (result.messageMeta?.actionRouter?.blockedSideEffects ?? []).includes(
      "AVAILABILITY_OWNER_CHECK_REQUIRED"
    )
  );
});

test("7: reply builders match approved copy", () => {
  assert.equal(
    buildAskDurationAvailabilityReply("Civic"),
    "Civic ka mai check kar leta hun. Kitne din ke liye chahiye?"
  );
  assert.equal(
    buildOwnerCheckDeferralReply("Civic", 3),
    "Civic 3 din ke liye mai confirm kar leta hun."
  );
});

test("8: availability owner-check execute flag defaults false", () => {
  const liveFlags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(liveFlags.availabilityOwnerCheckExecute, false);
});
