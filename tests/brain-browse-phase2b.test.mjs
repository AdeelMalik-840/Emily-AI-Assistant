/**
 * Phase 2B — browse/list consumes canonical booking-aware catalog availability.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildBrowseOptionsActionPlan,
  logCanonicalBrowseAvailabilityUsed,
  resolveBrowseAvailableRows,
} from "../src/brain/workflows/BrowseOptionsWorkflow.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { resolveCatalogBrowseAvailabilityFacts } from "../src/brain/facts/resolveCatalogBrowseAvailabilityFacts.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { getEmilyBrainV2LiveFlagSnapshot } from "../src/brain/config/liveFeatureFlags.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { buildShadowTurnContext } from "../src/brain/shadow/brainShadowHook.js";
import { isEmilyBrainV2LiveQuickGate } from "../src/services/whatsappInboundBuffer.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_fixture";
const fixture = loadSyntheticCarRentalCatalogFixture();
const flags = getEmilyBrainV2LiveFlagSnapshot();

function enableV2LiveEnv() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
}

function canonicalBrowseContext(catalogBrowse, businessId = BUSINESS_ID) {
  return {
    resolvedBusinessTurnContext: Object.freeze({
      businessId,
      verified: Object.freeze({
        catalogBrowse: Object.freeze({ ...catalogBrowse }),
      }),
    }),
  };
}

test("1: browse includes stale availability:false item when bookings say available", async () => {
  const { catalogBrowse } = await resolveCatalogBrowseAvailabilityFacts({
    businessId: BUSINESS_ID,
    catalogItems: fixture.items,
    getBookingsForItemFn: async () => [],
  });

  const stonic = catalogBrowse.items.find((item) => item.itemId === STONIC_ID);
  assert.equal(stonic?.isAvailable, true);
  assert.equal(stonic?.staleCatalogAvailability, true);

  const plan = buildBrowseOptionsActionPlan({
    catalogItems: fixture.items,
    businessContext: canonicalBrowseContext(catalogBrowse),
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_catalog_browse");
  assert.equal(plan.replyDraft, "");
  assert.ok(
    plan.actions[0]?.payload?.trustedBrowseFacts?.availableItems.some(
      (row) => /Stonic/i.test(row.displayLabel)
    )
  );
});

test("2: browse excludes item with active blocking booking", async () => {
  const { catalogBrowse } = await resolveCatalogBrowseAvailabilityFacts({
    businessId: BUSINESS_ID,
    catalogItems: fixture.items,
    getBookingsForItemFn: async (_businessId, itemId) => {
      if (itemId === CIVIC_ID) {
        return [{ id: "b-block", itemId: CIVIC_ID, status: "approved" }];
      }
      return [];
    },
  });

  const civic = catalogBrowse.items.find((item) => item.itemId === CIVIC_ID);
  assert.equal(civic?.isAvailable, false);
  assert.ok(civic?.blockingBookingCount > 0);

  const plan = buildBrowseOptionsActionPlan({
    catalogItems: fixture.items,
    businessContext: canonicalBrowseContext(catalogBrowse),
  });
  const labels = plan.actions[0]?.payload?.trustedBrowseFacts?.availableItems.map(
    (row) => row.displayLabel
  );
  assert.equal(labels.some((label) => /Civic/i.test(label)), false);
  assert.equal(labels.some((label) => /Corolla/i.test(label)), true);
});

test("3: browse uses canonical catalogBrowse source, not raw availability !== false", () => {
  const { source } = resolveBrowseAvailableRows({
    catalogItems: fixture.items,
    businessContext: canonicalBrowseContext({
      status: "resolved",
      source: "booking_aware_catalog_availability",
      totalCatalogItems: 3,
      availableCount: 3,
      unavailableCount: 0,
      items: fixture.items.map((row) => ({
        itemId: row.id,
        displayLabel: row.displayLabel,
        isAvailable: true,
        status: "available",
        staleCatalogAvailability: row.id === STONIC_ID,
        blockingBookingCount: 0,
      })),
    }),
  });
  assert.equal(source, "canonical_verified_catalog_browse");
});

test("4: [canonical_browse_availability_used] emitted", () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => {
    if (args[0] === "[canonical_browse_availability_used]") {
      captured.push(args[1]);
    }
    original(...args);
  };
  try {
    logCanonicalBrowseAvailabilityUsed(
      {
        status: "resolved",
        source: "booking_aware_catalog_availability",
        totalCatalogItems: 3,
        availableCount: 2,
        unavailableCount: 1,
        items: [],
      },
      BUSINESS_ID
    );
  } finally {
    console.log = original;
  }

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    workflowType: "browse_options",
    businessId: BUSINESS_ID,
    totalCatalogItems: 3,
    availableCount: 2,
    unavailableCount: 1,
    source: "booking_aware_catalog_availability",
  });
});

test("5: fallback works when canonical facts are absent", () => {
  const plan = buildBrowseOptionsActionPlan({
    catalogItems: fixture.items,
    businessContext: { catalogItems: fixture.items },
  });
  assert.equal(plan.actions[0]?.payload?.source, "verified_catalog");
  assert.equal(
    plan.actions[0]?.payload?.trustedBrowseFacts?.availableItems.some(
      (row) => /Stonic/i.test(row.displayLabel)
    ),
    false
  );
});

test("6: catalogBrowse hydrated only on browse turns", async () => {
  const turnContextInput = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "konsi cars available hain?",
    participantKey: "cust-1",
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  const browseCtx = await resolveBusinessTurnContext({
    traceId: "phase2b-browse-hydrate",
    businessId: BUSINESS_ID,
    rawMessage: "konsi cars available hain?",
    turnContextInput,
    turnContext: buildShadowTurnContext({
      businessId: BUSINESS_ID,
      isGroupInbound: true,
      memorySnapshot: {},
    }),
    catalogItems: fixture.items,
    flags,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });
  assert.equal(browseCtx.verified.catalogBrowse?.status, "resolved");
  assert.equal(browseCtx.verified.catalogBrowse?.availableCount, 3);

  const civicInput = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: "car-rental-queries",
    messageText: "Civic available?",
    participantKey: "cust-1",
    isGroupInbound: true,
    catalogItems: fixture.items,
    memorySnapshot: {},
  });
  const availCtx = await resolveBusinessTurnContext({
    traceId: "phase2b-avail-no-browse-hydrate",
    businessId: BUSINESS_ID,
    rawMessage: "Civic available?",
    turnContextInput: civicInput,
    turnContext: buildShadowTurnContext({
      businessId: BUSINESS_ID,
      isGroupInbound: true,
      memorySnapshot: {},
    }),
    catalogItems: fixture.items,
    flags,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });
  assert.equal(availCtx.verified.catalogBrowse, null);
});

test("7: v2 live browse still bypasses legacy", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2b-legacy-bypass",
    businessId: BUSINESS_ID,
    message: "konsi cars available hain?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
    __browseComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Honda Civic, Toyota Corolla aur Kia Stonic available hain. Aap kis option ko prefer karenge?",
        mentionedAvailableItemIds: [
          CIVIC_ID,
          "toyota_corolla_metallic_grey_fixture",
          STONIC_ID,
        ],
        replySemantics: {
          claims: ["resource_availability_confirmed"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }) } }],
    }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "browse_options");
  assert.equal(result.legacyBypassed, true);
  assert.match(String(result.reply ?? ""), /Stonic/i);
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);
});

test("8: v2 live browse excludes blocked item", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2b-browse-blocked",
    businessId: BUSINESS_ID,
    message: "konsi cars available hain?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    __browseComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Honda Civic aur Toyota Corolla available hain. Aap kis option ko prefer karenge?",
        mentionedAvailableItemIds: [
          CIVIC_ID,
          "toyota_corolla_metallic_grey_fixture",
        ],
        replySemantics: {
          claims: ["resource_availability_confirmed"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }) } }],
    }),
    getBookingsForItemFn: async (_businessId, itemId) => {
      if (itemId === STONIC_ID) {
        return [{ id: "b-stonic", itemId: STONIC_ID, status: "approved" }];
      }
      return [];
    },
    getBusinessProfileFn: async () => null,
  });
  assert.equal(result.workflowType, "browse_options");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.doesNotMatch(String(result.reply ?? ""), /Stonic/i);
});

test("9: browse workflow remains deterministic and does not call OpenAI", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflowFile = new URL(
    "../src/brain/workflows/BrowseOptionsWorkflow.js",
    import.meta.url
  );
  const text = await readFile(workflowFile, "utf8");
  assert.doesNotMatch(text, /from\s+["']openai/i);
  assert.doesNotMatch(text, /composeBrowseOptionsCustomerReply/);
});

test("10: booking/owner/DM execution remains disabled in flags", () => {
  const liveFlags = getEmilyBrainV2LiveFlagSnapshot();
  assert.equal(liveFlags.bookingExecute, false);
  assert.equal(liveFlags.ownerExecute, false);
  assert.equal(liveFlags.dmExecute, false);
});

test("11: canonical zero availability never falls back to raw catalog flags", () => {
  const plan = buildBrowseOptionsActionPlan({
    catalogItems: fixture.items.map((row) => ({ ...row, isAvailable: true })),
    businessContext: canonicalBrowseContext({
      status: "resolved",
      items: fixture.items.map((row) => ({ itemId: row.id, isAvailable: false })),
      availableCount: 0,
      unavailableCount: fixture.items.length,
      totalCatalogItems: fixture.items.length,
    }),
  });
  const facts = plan.actions[0]?.payload?.trustedBrowseFacts;
  assert.equal(facts?.availableCount, 0);
  assert.deepEqual(facts?.availableItems, []);
  assert.equal(plan.replyDraft, "");
  assert.equal(plan.actions[0]?.payload?.text, "");
});

test("12: browse composer failure is structured silence in the live path", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2b-browse-compose-failure",
    businessId: BUSINESS_ID,
    message: "konsi cars available hain?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
    __browseComposeChatCreate: async () => {
      throw new Error("synthetic compose failure");
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.reply, "");
  assert.equal(result.sendVia, "NONE");
  assert.match(String(result.reason ?? ""), /^BROWSE_COMPOSE_FAIL_CLOSED:/);
  assert.equal(result.legacyBypassed, true);
});
