import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  isEmilyBrainV2LiveEnabledForBusiness,
  getEmilyBrainV2LiveFlagSnapshot,
} from "../src/brain/config/liveFeatureFlags.js";
import {
  routeLiveActionPlan,
  assertLiveActionPlanIsSafe,
  executeLiveSideEffects,
  isLiveWorkflowType,
} from "../src/brain/live/actionRouter.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  isEmilyBrainV2LiveQuickGate,
  evaluateInboundBrainRoute,
  tryBrainV2LiveBeforeLegacy,
  executeWhatsAppAiPipeline,
  evaluateBrainRouteGate,
  isLegacyProcessMessageAllowed,
} from "../src/services/whatsappInboundBuffer.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} from "../src/brain/golden/goldenHarness.js";
import { patchEmilySessionState, getEmilySessionState } from "../src/services/conversationIntelligence.js";
import { __hasSafePreviousCatalogItemForPriceFollowupForTests } from "../src/services/messageProcessor.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";
import { executeOwnerNotification } from "../src/services/executors/ownerNotificationExecutor.js";
import { executeReplyPrivate } from "../src/services/executors/replyPrivateExecutor.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const OTHER_BUSINESS = "other-business-not-allowlisted";
const PARTICIPANT_A = "scope::participant-a";
const SESSION_A = `${BUSINESS_ID}::car-rental-queries::participant::${PARTICIPANT_A}`;

const envBackup = {
  EMILY_BRAIN_V2_LIVE: process.env.EMILY_BRAIN_V2_LIVE,
  EMILY_BRAIN_V2_LIVE_BUSINESSES: process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES,
  EMILY_BRAIN_V2_PRODUCTION_ALLOW: process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW,
  EMILY_BRAIN_V2_LEGACY_FALLBACK: process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK,
  EMILY_BRAIN_V2_BOOKING_EXECUTE: process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE,
  EMILY_BRAIN_V2_OWNER_EXECUTE: process.env.EMILY_BRAIN_V2_OWNER_EXECUTE,
  EMILY_BRAIN_V2_DM_EXECUTE: process.env.EMILY_BRAIN_V2_DM_EXECUTE,
  EMILY_BRAIN_V2_INFO_LIVE: process.env.EMILY_BRAIN_V2_INFO_LIVE,
};

function enableV2LiveForSyntheticBusiness() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  delete process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_OWNER_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_DM_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_INFO_LIVE;
}

test.afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("A: flags off → legacy route", () => {
  delete process.env.EMILY_BRAIN_V2_LIVE;
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), false);
  assert.equal(
    evaluateInboundBrainRoute({ businessId: BUSINESS_ID }),
    "legacy"
  );
});

test("B: v2 live disabled → legacy route uses processMessage", () => {
  delete process.env.EMILY_BRAIN_V2_LIVE;
  const source = executeWhatsAppAiPipeline.toString();
  assert.ok(source.includes("await processMessageFn({"));
  assert.equal(evaluateInboundBrainRoute({ businessId: BUSINESS_ID }), "legacy");
});

test("C: v2 live enabled + allowlisted → legacy guard blocks processMessage in hard mode", async () => {
  enableV2LiveForSyntheticBusiness();
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);

  const gate = evaluateBrainRouteGate({
    businessId: BUSINESS_ID,
    env: process.env,
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(
    isLegacyProcessMessageAllowed({ routeGate: gate, handledByBrainV2Live: false }),
    false
  );

  const source = executeWhatsAppAiPipeline.toString();
  assert.ok(source.includes("[brain_route_gate_evaluated]"));
  assert.ok(source.includes("isLegacyProcessMessageAllowed"));
});

test("D: Civic available? handled by v2 live", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "civic-live",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.equal(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_LIVE");
});

test("E: Stonic 10-day price handled by v2 live", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "stonic-live",
    businessId: BUSINESS_ID,
    message: "Stonic 10 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Stonic/i);
});

test("F: itemless price without trusted item asks clarification", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "itemless-live",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("G: stable participant follow-up uses trusted v2 session item", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  patchEmilySessionState(SESSION_A, {
    lastItem: { id: civic.itemId, name: civic.itemLabel, displayLabel: civic.itemLabel },
    lastResolvedItemId: civic.itemId,
    stage: "START",
  });
  const result = await runBrainV2LivePipeline({
    traceId: "civic-followup-live",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: PARTICIPANT_A,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    memorySnapshot: getEmilySessionState(SESSION_A),
    sessionKey: SESSION_A,
    playwrightChatKey: "car-rental-queries",
    resolveTrustedSessionItem: (p) =>
      __hasSafePreviousCatalogItemForPriceFollowupForTests({
        memory: p.memory,
        message: p.message,
        catalogItems: p.catalogItems,
        participantKey: p.participantKey,
        chatContextKey: p.chatContextKey,
        sessionKey: p.sessionKey,
        traceId: p.traceId,
        isGroupInbound: p.isGroupInbound,
      }),
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Stonic/i);
});

test("H: missing identity + explicit item works", () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "Civic available?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  assert.equal(input.shouldClarifyItem, false);
  assert.equal(input.explicitItem?.id, resolveCatalogItemFromMessage(fixture, "Civic available?").itemId);
});

test("I: missing identity + itemless follow-up clarifies", () => {
  enableV2LiveForSyntheticBusiness();
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
    memorySnapshot: {},
  });
  assert.equal(input.shouldClarifyItem, true);
});

test("J: booking request produces v2 action plan", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "booking-plan",
    businessId: BUSINESS_ID,
    message: "book kr do Civic 3 din",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "booking_request");
  assert.ok(result.messageMeta?.actionPlan);
  assert.ok(
    Array.isArray(result.messageMeta?.actionPlan?.actions) &&
      result.messageMeta.actionPlan.actions.some((a) => a.type === "CREATE_BOOKING")
  );
});

test("K: booking execution blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.bookingExecute, false);
  const routed = routeLiveActionPlan(
    {
      planId: "booking-blocked",
      replyDraft: "Booking ack",
      actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "x", durationDays: 3 } }],
    },
    flags
  );
  assert.equal(routed.hasDisallowedExecute, true);
  assert.throws(() => assertLiveActionPlanIsSafe(
    {
      planId: "bad-booking",
      actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "x", durationDays: 3 } }],
    },
    flags
  ));
});

test("L: owner notification blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.ownerExecute, false);
  await assert.rejects(
    () =>
      executeLiveSideEffects({
        actionPlan: {
          planId: "owner-blocked",
          actions: [
            {
              type: "NOTIFY_OWNER",
              payload: { execute: true },
            },
          ],
        },
        routed: routeLiveActionPlan(
          {
            planId: "owner-blocked",
            actions: [{ type: "NOTIFY_OWNER", payload: { execute: true } }],
          },
          flags
        ),
        flags,
        executionContext: { businessId: BUSINESS_ID, traceId: "owner-test" },
      }),
    /live_side_effect_blocked:NOTIFY_OWNER/
  );
});

test("M: DM blocked by default", async () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(flags.dmExecute, false);
  const dm = await executeReplyPrivate({
    payload: { text: "hello", recipientPhone: "923001234567" },
    executionContext: { participantPhoneForDm: "923001234567" },
  });
  assert.equal(dm.blocked, true);
});

test("N: unsafe execute:true side-effect throws", () => {
  enableV2LiveForSyntheticBusiness();
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  assert.throws(() =>
    assertLiveActionPlanIsSafe(
      {
        planId: "unsafe",
        actions: [{ type: "CREATE_BOOKING", payload: { execute: true, itemId: "a", durationDays: 2 } }],
      },
      flags
    )
  );
});

test("O/P: v2 live path does not invoke legacy fuzzy or memory resolver", async () => {
  enableV2LiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await runBrainV2LivePipeline({
    traceId: "no-legacy-paths",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: { lastItem: { id: "stonic-1", name: "Kia Stonic" } },
  });
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
  assert.notEqual(result.messageMeta?.outboundTrace?.finalReplySource, "LEGACY");
});

test("live workflow set includes booking and greeting", () => {
  assert.equal(isLiveWorkflowType("booking_request"), true);
  assert.equal(isLiveWorkflowType("greeting"), true);
  assert.equal(isLiveWorkflowType("unknown_clarification"), true);
});

test("non-allowlisted business stays off v2 live", () => {
  enableV2LiveForSyntheticBusiness();
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = OTHER_BUSINESS;
  assert.equal(isEmilyBrainV2LiveEnabledForBusiness(BUSINESS_ID), false);
});

test("buffer wrapper returns v2 live result when enabled", async () => {
  enableV2LiveForSyntheticBusiness();
  const result = await tryBrainV2LiveBeforeLegacy({
    traceId: "buffer-live",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
    isGroupInbound: true,
    chatType: "group",
  });
  assert.equal(result.handled, true);
  assert.equal(result.legacyBypassed, true);
});

test("booking executor validates payload without brain decisions", async () => {
  const blocked = await executeCreateBooking({
    payload: { itemId: "", durationDays: 3 },
    executionContext: { businessId: BUSINESS_ID, traceId: "exec-test" },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "MISSING_ITEM_ID");
});

test("owner executor blocked without booking context", async () => {
  const out = await executeOwnerNotification({
    payload: {},
    booking: {},
    executionContext: { businessId: BUSINESS_ID, traceId: "owner-exec" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "MISSING_BOOKING_ID");
});

test("pipeline source guards processMessage when v2 live handled", () => {
  const source = executeWhatsAppAiPipeline.toString();
  assert.ok(source.includes("handledByBrainV2Live"));
  assert.ok(source.includes("v2LiveEligible"));
});
