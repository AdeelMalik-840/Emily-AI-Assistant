/**
 * Phase 1 — canonical facts resolver (log-only, no reply behavior change).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildCanonicalFactsLogPayload } from "../src/brain/facts/logCanonicalFacts.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { getEmilyBrainV2LiveFlagSnapshot } from "../src/brain/config/liveFeatureFlags.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  loadBrainV2SessionMemorySnapshot,
  prepareEmilyBrainV2ShadowMemorySnapshot,
  isEmilyBrainV2LiveQuickGate,
} from "../src/services/whatsappInboundBuffer.js";
import { patchEmilySessionState } from "../src/services/conversationIntelligence.js";
import { buildShadowTurnContext } from "../src/brain/shadow/brainShadowHook.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const fixture = loadSyntheticCarRentalCatalogFixture();
const flags = getEmilyBrainV2LiveFlagSnapshot();

function baseTurnContextInput(message, participantKey = "cust-1") {
  return buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: message,
    participantKey,
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
}

function baseTurnContext(participantKey = "cust-1") {
  return buildShadowTurnContext({
    businessId: BUSINESS_ID,
    participantKey,
    playwrightChatKey: "car-rental-queries",
    isGroupInbound: true,
    memorySnapshot: {},
  });
}

test("1-3: Civic canonical facts resolve with schema v1, turn, signals, evidence", async () => {
  const message = "Civic available?";
  const turnContextInput = baseTurnContextInput(message);
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-1",
    businessId: BUSINESS_ID,
    rawMessage: message,
    turnContextInput,
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });

  assert.equal(facts.schemaVersion, "v1");
  assert.equal(facts.resolvedItem.id, CIVIC_ID);
  assert.equal(facts.resolvedItem.status, "resolved");
  assert.ok(facts.turn);
  assert.ok(facts.signals);
  assert.ok(facts.resolutionStatus);
  assert.ok(facts.sourceEvidence?.item);
  assert.ok(facts.sourceEvidence?.availability);
});

test("4: canonical pricing daily 8000 for Civic", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-4",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: baseTurnContextInput("Civic available?"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.verified.pricing.daily, 8000);
});

test("5: canonical 3-day Civic quote totals 24000", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-5",
    businessId: BUSINESS_ID,
    rawMessage: "Civic 3 din ka rent kitna hai?",
    turnContextInput: baseTurnContextInput("Civic 3 din ka rent kitna hai?"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.verified.priceQuote.durationDays, 3);
  assert.equal(facts.verified.priceQuote.total, 24000);
  assert.equal(facts.verified.priceQuote.dailyRate, 8000);
});

test("6-7: booking-aware availability; stale catalog false + empty bookings = available", async () => {
  const items = fixture.items.map((row) =>
    row.id === CIVIC_ID ? { ...row, availability: false } : row
  );
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-7",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: baseTurnContextInput("Civic available?"),
    turnContext: baseTurnContext(),
    catalogItems: items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.verified.availability.source, "computeUserFacingAvailability");
  assert.equal(facts.verified.availability.bookingAware, true);
  assert.equal(facts.verified.availability.isAvailable, true);
  assert.equal(facts.verified.availability.staleCatalogAvailability, true);
  assert.equal(facts.verified.availability.status, "available");
});

test("8-9: active blocking booking unavailable with reliable end date", async () => {
  const endAt = new Date("2026-08-15T12:00:00.000Z");
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-9",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: baseTurnContextInput("Civic available?"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [
      {
        id: "booking-approved-1",
        itemId: CIVIC_ID,
        status: "approved",
        startAt: new Date("2026-06-01T00:00:00.000Z"),
        endAt,
      },
    ],
  });
  assert.equal(facts.verified.availability.isAvailable, false);
  assert.equal(facts.verified.availability.status, "unavailable");
  assert.equal(facts.verified.availability.blockingBookingCount, 1);
  assert.equal(facts.verified.availability.nextAvailableAt, endAt.toISOString());
  assert.equal(facts.verified.availability.unavailableUntil, endAt.toISOString());
  assert.equal(facts.verified.availability.dateConfidence, "exact");
  assert.equal(facts.verified.availability.dateSource, "endAt");
});

test("10: blocking booking without end date does not invent availability date", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-10",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: baseTurnContextInput("Civic available?"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [
      { id: "booking-no-end", itemId: CIVIC_ID, status: "approved" },
    ],
  });
  assert.equal(facts.verified.availability.isAvailable, false);
  assert.equal(facts.verified.availability.nextAvailableAt, null);
  assert.equal(facts.verified.availability.unavailableUntil, null);
  assert.equal(facts.verified.availability.dateConfidence, "none");
  assert.equal(facts.verified.availability.reason, "unavailable_date_unknown");
});

test("11-12: media facts detect images; logs omit full URLs", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-12",
    businessId: BUSINESS_ID,
    rawMessage: "Civic ki picture share kr dn",
    turnContextInput: baseTurnContextInput("Civic ki picture share kr dn"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.verified.media.hasImages, true);
  assert.equal(facts.verified.media.imageCount, 1);
  const logPayload = buildCanonicalFactsLogPayload(facts);
  const logJson = JSON.stringify(logPayload);
  assert.doesNotMatch(logJson, /fixtures\/civic-white\.jpg/);
  assert.ok(Array.isArray(logPayload.verified.media.imageHashes));
  assert.equal(logPayload.verified.media.imageHashes.length, 1);
});

test("13-14: action policy blocked + forbidden claims when execute flags false", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-14",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: baseTurnContextInput("Civic available?"),
    turnContext: baseTurnContext(),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.actions.bookingExecute, false);
  assert.equal(facts.actions.ownerExecute, false);
  assert.equal(facts.actions.dmExecute, false);
  assert.ok(facts.actions.blocked.includes("CREATE_BOOKING"));
  assert.ok(facts.forbiddenClaims.includes("booking_created"));
  assert.ok(facts.forbiddenClaims.includes("owner_notified"));
  assert.ok(facts.forbiddenClaims.includes("dm_sent"));
  assert.ok(facts.forbiddenClaims.includes("image_sent"));
});

test("15-16: unresolved group participant blocks memory + itemless follow-up", async () => {
  const facts = await resolveBusinessTurnContext({
    traceId: "canonical-16",
    businessId: BUSINESS_ID,
    rawMessage: "10 din k lye rent kitna hai?",
    turnContextInput: buildTurnContextInput({
      channel: "whatsapp_web",
      chatType: "group",
      businessId: BUSINESS_ID,
      chatId: "car-rental-queries",
      messageText: "10 din k lye rent kitna hai?",
      participantKey: null,
      isGroupInbound: true,
      catalogItems: fixture.items,
      memorySnapshot: {},
    }),
    turnContext: buildShadowTurnContext({
      businessId: BUSINESS_ID,
      participantKey: "",
      playwrightChatKey: "car-rental-queries",
      isGroupInbound: true,
      memorySnapshot: {},
    }),
    catalogItems: fixture.items,
    flags,
    log: false,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
  });
  assert.equal(facts.participant.memoryAllowed, false);
  assert.equal(facts.replyConstraints.groupItemlessFollowupAllowed, false);
});

test("17: v2 live memory loads when shadow flag is off", async () => {
  const sessionKey = `${BUSINESS_ID}::car-rental-queries::participant::memory-test`;
  patchEmilySessionState(sessionKey, {
    lastResolvedItemId: CIVIC_ID,
    lastItem: { id: CIVIC_ID, name: "Honda Civic 2026 Oriel" },
  });

  const shadowOnly = await prepareEmilyBrainV2ShadowMemorySnapshot({
    shadowEligible: false,
    traceId: "mem-shadow-off",
    businessId: BUSINESS_ID,
    ownerUserId: BUSINESS_ID,
    sessionKey,
    participantKey: "memory-test",
    playwrightChatKey: "car-rental-queries",
    isGroupInbound: true,
    peekSessionState: (key) =>
      key === sessionKey ? { lastResolvedItemId: CIVIC_ID } : null,
  });
  assert.equal(shadowOnly, null);

  const liveMemory = await loadBrainV2SessionMemorySnapshot({
    traceId: "mem-live-on",
    businessId: BUSINESS_ID,
    ownerUserId: BUSINESS_ID,
    sessionKey,
    participantKey: "memory-test",
    playwrightChatKey: "car-rental-queries",
    isGroupInbound: true,
    peekSessionState: (key) =>
      key === sessionKey ? { lastResolvedItemId: CIVIC_ID } : null,
  });
  assert.equal(liveMemory?.lastResolvedItemId, CIVIC_ID);
});

test("18-20: v2 live replies unchanged; legacy bypassed; pipeline still works", async () => {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";

  const cases = [
    {
      message: "Civic available?",
      expect: /Kitne din ke liye chahiye/i,
    },
    {
      message: "Civic 3 din ka rent kitna hai?",
      expect: /40,000 PKR|24,000 PKR/,
    },
  ];

  for (const row of cases) {
    const result = await runBrainV2LivePipeline({
      traceId: `phase1-${row.message.slice(0, 12)}`,
      businessId: BUSINESS_ID,
      message: row.message,
      catalogItems: fixture.items,
      isGroupInbound: true,
      chatType: "group",
      participantKey: "cust-alpha",
      getBookingsForItemFn: async () => [],
      __testOrchestratorFn: undefined,
    });
    assert.equal(result.handled, true);
    assert.equal(result.legacyBypassed, true);
    assert.match(String(result.reply ?? ""), row.expect);
  }

  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);
});
