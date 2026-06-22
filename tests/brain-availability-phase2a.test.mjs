/**
 * Phase 2A — availability workflow consumes canonical verified availability.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildAvailabilityInquiryActionPlan,
  buildAvailabilityReplyFromCanonical,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { runConversationTurn } from "../src/brain/orchestrator/ConversationOrchestrator.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { getEmilyBrainV2LiveFlagSnapshot } from "../src/brain/config/liveFeatureFlags.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { buildShadowTurnContext } from "../src/brain/shadow/brainShadowHook.js";
import { isEmilyBrainV2LiveQuickGate } from "../src/services/whatsappInboundBuffer.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const fixture = loadSyntheticCarRentalCatalogFixture();
const flags = getEmilyBrainV2LiveFlagSnapshot();

function makeAdmittedTurn(message) {
  return {
    turn: {
      turnId: "phase2a-turn",
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "car-rental-queries",
      participantKey: "cust-1",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "phase2a::turn",
    admissionReason: "test",
  };
}

function makeUnderstanding(overrides = {}) {
  return {
    resolvedItemId: CIVIC_ID,
    resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
    itemSource: "explicit",
    itemConfidence: "high",
    intentsRanked: ["availability_check"],
    askedField: "availability",
    ...overrides,
  };
}

function canonicalContext(availability, itemOverrides = {}, turnOverrides = {}) {
  return Object.freeze({
    schemaVersion: "v1",
    resolvedItem: {
      id: CIVIC_ID,
      name: "Honda Civic 2026 Oriel",
      displayLabel: "Honda Civic 2026 Oriel (White)",
      ...itemOverrides,
    },
    turn: {
      durationDays: turnOverrides.durationDays ?? null,
    },
    verified: Object.freeze({
      availability: Object.freeze({ ...availability }),
      priceQuote: Object.freeze({
        status: "not_requested",
        durationDays: null,
        total: null,
        currency: "PKR",
      }),
    }),
  });
}

test("1: AvailabilityWorkflow asks duration when canonical item has no duration", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic available?"),
    understanding: makeUnderstanding(),
    catalogItems: fixture.items,
    businessContext: {
      resolvedBusinessTurnContext: canonicalContext({
        status: "available",
        isAvailable: true,
        source: "computeUserFacingAvailability",
        bookingAware: true,
        blockingBookingCount: 0,
        nextAvailableAt: null,
        staleCatalogAvailability: true,
      }),
    },
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_owner_check_ask_duration");
  assert.match(String(plan.replyDraft ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Available hai/i);
});

test("2+6: availability:false + empty bookings → ask duration via live pipeline", async () => {
  const items = fixture.items.map((row) =>
    row.id === CIVIC_ID ? { ...row, availability: false } : row
  );
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";

  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-stale-catalog",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });

  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "availability_inquiry");
  assert.match(String(result.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Available hai/i);
});

test("3: active blocking booking → ask duration before owner check", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-blocked",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [
      { id: "b-block", itemId: CIVIC_ID, status: "approved" },
    ],
  });
  assert.match(String(result.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(result.reply ?? ""), /available nahi/i);
});

test("4: blocking booking with endAt still asks duration when date missing from ask", async () => {
  const endAt = new Date("2026-08-15T12:00:00.000Z");
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-with-end",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [
      {
        id: "b-end",
        itemId: CIVIC_ID,
        status: "approved",
        startAt: new Date("2026-06-01T00:00:00.000Z"),
        endAt,
      },
    ],
  });
  assert.match(String(result.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Expected availability/i);
});

test("5: missing booking end date does not invent date in reply", async () => {
  const reply = buildAvailabilityReplyFromCanonical("Honda Civic 2026 Oriel (White)", {
    status: "unavailable",
    isAvailable: false,
    nextAvailableAt: null,
    reason: "unavailable_date_unknown",
  });
  assert.match(reply, /Abhi available nahi hai/i);
  assert.doesNotMatch(reply, /Expected availability/i);

  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-no-end",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [
      { id: "b-no-end", itemId: CIVIC_ID, status: "approved" },
    ],
  });
  assert.match(String(result.reply ?? ""), /Kitne din ke liye chahiye/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Expected availability/i);
});

test("fallback: orchestrator without canonical facts keeps catalog composer path", () => {
  const items = fixture.items.map((row) =>
    row.id === CIVIC_ID ? { ...row, availability: false } : row
  );
  const result = runConversationTurn({
    traceId: "phase2a-fallback",
    admittedTurn: makeAdmittedTurn("Civic available?"),
    turnContext: buildShadowTurnContext({
      businessId: BUSINESS_ID,
      participantKey: "cust-1",
      playwrightChatKey: "car-rental-queries",
      isGroupInbound: true,
      memorySnapshot: {},
    }),
    businessContext: { catalogItems: items },
  });
  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.match(String(result.actionPlan?.replyDraft ?? ""), /available nahi/i);
});

test("7: pricing replies unchanged via live pipeline", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-pricing",
    businessId: BUSINESS_ID,
    message: "Civic 3 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /24,000 PKR/);
});

test("8: media workflow unchanged without canonical availability injection", async () => {
  const turnContextInput = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "Civic ki picture share kr dn",
    participantKey: "cust-1",
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  const facts = await resolveBusinessTurnContext({
    traceId: "phase2a-media",
    businessId: BUSINESS_ID,
    rawMessage: "Civic ki picture share kr dn",
    turnContextInput,
    turnContext: buildShadowTurnContext({
      businessId: BUSINESS_ID,
      participantKey: "cust-1",
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
  assert.equal(facts.verified.media.hasImages, true);
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-media-live",
    businessId: BUSINESS_ID,
    message: "Civic ki picture share kr dn",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.notEqual(result.workflowType, "availability_inquiry");
});

test("9: booking request workflow unchanged", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-booking",
    businessId: BUSINESS_ID,
    message: "Civic book kar do 3 din ke liye",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.workflowType, "booking_request");
});

test("11: v2 still bypasses legacy", async () => {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  const result = await runBrainV2LivePipeline({
    traceId: "phase2a-legacy-bypass",
    businessId: BUSINESS_ID,
    message: "Civic available?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.legacyBypassed, true);
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);
});

test("12: brain module has no OpenAI imports", async () => {
  const { readFile } = await import("node:fs/promises");
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const brainRoot = new URL("../src/brain", import.meta.url).pathname;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) files.push(full);
    }
    return files;
  }
  const brainFiles = await walk(brainRoot);
  for (const file of brainFiles) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /from\s+["']openai/i, `OpenAI import in ${file}`);
  }
});

test("13: booking/owner/DM/availability owner-check execution remains disabled in flags", () => {
  const liveFlags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(liveFlags.bookingExecute, false);
  assert.equal(liveFlags.ownerExecute, false);
  assert.equal(liveFlags.dmExecute, false);
  assert.equal(liveFlags.availabilityOwnerCheckExecute, false);
});
