import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  isEmilyBrainV2InfoLiveEnabledForBusiness,
  getEmilyBrainV2InfoLiveFlagSnapshot,
} from "../src/brain/config/infoLiveFeatureFlags.js";
import {
  routeInfoLiveActionPlan,
  assertInfoLiveActionPlanIsSafe,
  isInfoLiveWorkflowType,
} from "../src/brain/live/actionRouter.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { tryBrainV2InfoLiveTurn } from "../src/brain/live/brainV2InfoLiveAdapter.js";
import {
  isEmilyBrainV2InfoLiveQuickGate,
  tryBrainV2InfoLiveBeforeLegacy,
} from "../src/services/whatsappInboundBuffer.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} from "../src/brain/golden/goldenHarness.js";
import { patchEmilySessionState, getEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveTrustedPreviousItemContinuation as __hasSafePreviousCatalogItemForPriceFollowupForTests } from "../src/brain/context/previousItemContinuationResolver.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const OTHER_BUSINESS = "other-business-not-allowlisted";
const PARTICIPANT_A = "scope::participant-a";
const SESSION_A = `${BUSINESS_ID}::car-rental-queries::participant::${PARTICIPANT_A}`;

const envBackup = {
  EMILY_BRAIN_V2_INFO_LIVE: process.env.EMILY_BRAIN_V2_INFO_LIVE,
  EMILY_BRAIN_V2_INFO_BUSINESSES: process.env.EMILY_BRAIN_V2_INFO_BUSINESSES,
  EMILY_BRAIN_V2_PRODUCTION_ALLOW: process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW,
  EMILY_BRAIN_V2_BOOKING_LIVE: process.env.EMILY_BRAIN_V2_BOOKING_LIVE,
  EMILY_BRAIN_V2_OWNER_LIVE: process.env.EMILY_BRAIN_V2_OWNER_LIVE,
  EMILY_BRAIN_V2_DM_LIVE: process.env.EMILY_BRAIN_V2_DM_LIVE,
};

function enableInfoLiveForSyntheticBusiness() {
  process.env.EMILY_BRAIN_V2_INFO_LIVE = "true";
  process.env.EMILY_BRAIN_V2_INFO_BUSINESSES = BUSINESS_ID;
  delete process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW;
  delete process.env.EMILY_BRAIN_V2_BOOKING_LIVE;
  delete process.env.EMILY_BRAIN_V2_OWNER_LIVE;
  delete process.env.EMILY_BRAIN_V2_DM_LIVE;
}

test.afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("A: flags off → no v2 live routing", async () => {
  delete process.env.EMILY_BRAIN_V2_INFO_LIVE;
  assert.equal(isEmilyBrainV2InfoLiveQuickGate(BUSINESS_ID), false);
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "flags-off",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "INFO_LIVE_DISABLED");
});

test("B: non-allowlisted business → no v2 live routing", async () => {
  process.env.EMILY_BRAIN_V2_INFO_LIVE = "true";
  process.env.EMILY_BRAIN_V2_INFO_BUSINESSES = OTHER_BUSINESS;
  assert.equal(isEmilyBrainV2InfoLiveEnabledForBusiness(BUSINESS_ID), false);
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "not-allowlisted",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
  });
  assert.equal(result.handled, false);
});

test("action router blocks side effects and allows reply only", () => {
  const flags = getEmilyBrainV2InfoLiveFlagSnapshot();
  const routed = routeInfoLiveActionPlan(
    {
      planId: "plan-1",
      replyDraft: "Civic available hai.",
      actions: [
        { type: "REPLY", payload: { text: "Civic available hai.", execute: false } },
        { type: "CREATE_BOOKING", payload: { execute: true } },
        { type: "NOTIFY_OWNER", payload: { execute: false } },
      ],
    },
    flags
  );
  assert.equal(routed.reply, "Civic available hai.");
  assert.ok(routed.blockedSideEffects.includes("CREATE_BOOKING"));
  assert.ok(routed.blockedSideEffects.includes("NOTIFY_OWNER"));
  assert.equal(routed.hasDisallowedExecute, true);
  assert.throws(() => assertInfoLiveActionPlanIsSafe(
    {
      planId: "bad",
      actions: [{ type: "CREATE_BOOKING", payload: { execute: true } }],
    },
    flags
  ));
});

test("C: allowlisted + live — Civic availability handled by v2", async () => {
  enableInfoLiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "civic-avail",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    participantKey: null,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    playwrightChatKey: "car-rental-queries",
    sessionKey: SESSION_A,
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.equal(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_INFO_LIVE");
});

test("C2: Stonic 10-day price handled by v2", async () => {
  enableInfoLiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "stonic-price",
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

test("C3: itemless price without trusted item asks which car", async () => {
  enableInfoLiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "itemless-price",
    businessId: BUSINESS_ID,
    message: "10 din k lye rent kitna hai?",
    participantKey: null,
    isGroupInbound: true,
    chatType: "group",
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "AUTHORITY_CLARIFY");
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("C4: same stable participant Civic follow-up returns Civic price", async () => {
  enableInfoLiveForSyntheticBusiness();
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  patchEmilySessionState(SESSION_A, {
    lastItem: { id: civic.itemId, name: civic.itemLabel, displayLabel: civic.itemLabel },
    lastResolvedItemId: civic.itemId,
    stage: "START",
  });
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "civic-followup-price",
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
        continuationContextNeeded: p.continuationContextNeeded,
        continuationKind: p.continuationKind,
      }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Stonic/i);
});

test("D: booking intent falls through to legacy", async () => {
  enableInfoLiveForSyntheticBusiness();
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "booking-legacy",
    businessId: BUSINESS_ID,
    message: "book kr do Civic 3 din",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
    isGroupInbound: true,
    chatType: "group",
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "booking_request", reason: "test" },
      actionPlan: {
        planId: "booking-plan",
        replyDraft: "Booking plan",
        actions: [{ type: "CREATE_BOOKING", payload: { execute: false } }],
      },
      understanding: {},
      trace: {},
    }),
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "BOOKING_LEGACY");
});

test("E: DM continuation stays legacy-only", async () => {
  enableInfoLiveForSyntheticBusiness();
  const result = await tryBrainV2InfoLiveTurn({
    traceId: "dm-legacy",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    isDmContinuation: true,
    chatType: "dm",
    catalogItems: loadSyntheticCarRentalCatalogFixture().items,
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "DM_LEGACY_ONLY");
});

test("I: missing identity + explicit item works via TurnContext input", () => {
  enableInfoLiveForSyntheticBusiness();
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

test("J: missing identity + itemless follow-up clarifies", () => {
  enableInfoLiveForSyntheticBusiness();
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
  assert.match(String(input.clarificationReply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("K: info live workflow set excludes booking", () => {
  assert.equal(isInfoLiveWorkflowType("availability_inquiry"), true);
  assert.equal(isInfoLiveWorkflowType("pricing_with_duration"), true);
  assert.equal(isInfoLiveWorkflowType("booking_request"), false);
});

test("buffer wrapper returns handled false when flags off", async () => {
  delete process.env.EMILY_BRAIN_V2_INFO_LIVE;
  const result = await tryBrainV2InfoLiveBeforeLegacy({
    traceId: "buffer-off",
    businessId: BUSINESS_ID,
    message: "Civic available?",
  });
  assert.equal(result.handled, false);
});
