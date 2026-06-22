/**
 * Phase 2C — pricing workflows consume canonical verified pricing facts.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildPricingInquiryActionPlan,
  buildPricingReplyFromCanonical,
  logCanonicalPricingUsed,
} from "../src/brain/workflows/PricingInquiryWorkflow.js";
import {
  buildPricingWithDurationActionPlan,
  buildPriceQuoteReplyFromCanonical,
  logCanonicalPriceQuoteUsed,
} from "../src/brain/workflows/PricingWithDurationWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { loadSyntheticCarRentalCatalogFixture } from "../src/brain/golden/goldenHarness.js";
import { getEmilyBrainV2LiveFlagSnapshot } from "../src/brain/config/liveFeatureFlags.js";
import { isEmilyBrainV2LiveQuickGate } from "../src/services/whatsappInboundBuffer.js";

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_fixture";
const fixture = loadSyntheticCarRentalCatalogFixture();
const flags = getEmilyBrainV2LiveFlagSnapshot();

function makeAdmittedTurn(message) {
  return {
    turn: {
      turnId: "phase2c-turn",
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "car-rental-queries",
      participantKey: "cust-1",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "phase2c::turn",
    admissionReason: "test",
  };
}

function makeUnderstanding(overrides = {}) {
  return {
    resolvedItemId: CIVIC_ID,
    resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
    itemSource: "explicit",
    itemConfidence: "high",
    intentsRanked: ["price"],
    askedField: "price",
    durationDays: null,
    ...overrides,
  };
}

function canonicalBusinessContext(verifiedOverrides = {}, itemOverrides = {}) {
  return {
    resolvedBusinessTurnContext: Object.freeze({
      businessId: BUSINESS_ID,
      resolvedItem: Object.freeze({
        id: CIVIC_ID,
        displayLabel: "Honda Civic 2026 Oriel (White)",
        ...itemOverrides,
      }),
      verified: Object.freeze({
        pricing: Object.freeze({
          status: "resolved",
          daily: 8000,
          monthly: 165000,
          currency: "PKR",
          source: "catalog.pricing",
          hasPricing: true,
          missingFields: [],
        }),
        priceQuote: Object.freeze({
          status: "not_requested",
          durationDays: null,
          dailyRate: null,
          total: null,
          currency: "PKR",
          source: null,
        }),
        ...verifiedOverrides,
      }),
    }),
  };
}

function enableV2LiveEnv() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
}

test("1: daily price uses canonical verified.pricing", () => {
  const plan = buildPricingInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic ka rent kitna hai?"),
    understanding: makeUnderstanding(),
    catalogItems: fixture.items,
    businessContext: canonicalBusinessContext(),
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_pricing");
  assert.match(String(plan.replyDraft ?? ""), /8,000 PKR per day/i);
  assert.match(String(plan.replyDraft ?? ""), /165,000 PKR per month/i);
});

test("2: duration price uses canonical priceQuote.total — Civic 24,000", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2c-civic-3d",
    businessId: BUSINESS_ID,
    message: "Civic 3 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /24,000 PKR/i);
  assert.equal(result.legacyBypassed, true);
});

test("3: Corolla 3-day quote is 15,000 PKR", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2c-corolla-3d",
    businessId: BUSINESS_ID,
    message: "Corolla ka 3 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /15,000 PKR/i);
});

test("4: Stonic 10-day quote is 70,000 PKR", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2c-stonic-10d",
    businessId: BUSINESS_ID,
    message: "Stonic 10 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /70,000 PKR/i);
});

test("5: workflow does not recalculate total when canonical total exists", () => {
  const reply = buildPriceQuoteReplyFromCanonical(
    "Test Car",
    {
      status: "resolved",
      durationDays: 3,
      dailyRate: 1,
      total: 99999,
      currency: "PKR",
      source: "catalog_daily_x_duration",
    },
    "3 din ka rent kitna hai?"
  );
  assert.match(reply, /99,999 PKR/i);
  assert.doesNotMatch(reply, /\b3 PKR\b/i);
});

test("6: missing pricing does not invent a number", () => {
  const plan = buildPricingInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic ka rent kitna hai?"),
    understanding: makeUnderstanding(),
    catalogItems: fixture.items,
    businessContext: canonicalBusinessContext({
      pricing: Object.freeze({
        status: "missing",
        daily: null,
        monthly: null,
        currency: "PKR",
        source: null,
        hasPricing: false,
        missingFields: ["pricing.daily_or_monthly"],
      }),
    }),
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_pricing_missing");
  assert.match(String(plan.replyDraft ?? ""), /Rate confirm kar ke bata deta hun/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /\b\d{2,}\b/);
});

test("7: canonical-vs-raw divergence uses canonical pricing not catalog row", () => {
  const skewedCatalog = fixture.items.map((row) =>
    row.id === CIVIC_ID
      ? {
          ...row,
          pricing: { daily: 100, monthly: 1000, currency: "PKR" },
        }
      : row
  );
  const plan = buildPricingInquiryActionPlan({
    admittedTurn: makeAdmittedTurn("Civic ka rent kitna hai?"),
    understanding: makeUnderstanding(),
    catalogItems: skewedCatalog,
    businessContext: canonicalBusinessContext(),
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_pricing");
  assert.match(String(plan.replyDraft ?? ""), /8,000 PKR/i);
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /100 PKR/i);
});

test("8: itemless rent kitna hai asks for item (pipeline/orchestrator clarification)", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2c-itemless",
    businessId: BUSINESS_ID,
    message: "rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: null,
    memorySnapshot: {},
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.handled, true);
  assert.match(
    String(result.reply ?? ""),
    /Kis (car ke liye price pooch rahe hain|item ke liye dekh rahe hain)/i
  );
  assert.doesNotMatch(String(result.reply ?? ""), /\b8,000\b|\b15,000\b/);
});

test("9: [canonical_pricing_used] log payload is safe", () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => {
    if (args[0] === "[canonical_pricing_used]") captured.push(args[1]);
    original(...args);
  };
  try {
    logCanonicalPricingUsed({
      itemId: CIVIC_ID,
      itemLabel: "Honda Civic 2026 Oriel (White)",
      pricing: {
        status: "resolved",
        daily: 8000,
        monthly: 165000,
        currency: "PKR",
        source: "catalog.pricing",
        hasPricing: true,
      },
    });
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].workflowType, "pricing_inquiry");
  assert.equal(captured[0].hasPrice, true);
  assert.equal(captured[0].itemId, CIVIC_ID);
});

test("10: [canonical_price_quote_used] log payload is safe", () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => {
    if (args[0] === "[canonical_price_quote_used]") captured.push(args[1]);
    original(...args);
  };
  try {
    logCanonicalPriceQuoteUsed({
      itemId: COROLLA_ID,
      itemLabel: "Toyota corolla (Metallic Grey)",
      priceQuote: {
        status: "resolved",
        durationDays: 3,
        dailyRate: 5000,
        total: 15000,
        currency: "PKR",
        source: "catalog_daily_x_duration",
      },
    });
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].workflowType, "pricing_with_duration");
  assert.equal(captured[0].hasTotal, true);
  assert.equal(captured[0].durationDays, 3);
});

test("11: duration workflow uses canonical priceQuote in action plan", () => {
  const plan = buildPricingWithDurationActionPlan({
    admittedTurn: makeAdmittedTurn("Corolla ka 3 din ka rent kitna hai?"),
    turnContext: { businessId: BUSINESS_ID, memorySnapshot: {} },
    understanding: makeUnderstanding({
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota corolla (Metallic Grey)",
      durationDays: 3,
      askedField: "price_with_duration",
    }),
    catalogItems: fixture.items,
    businessContext: canonicalBusinessContext({
      pricing: Object.freeze({
        status: "resolved",
        daily: 5000,
        monthly: 120000,
        currency: "PKR",
        source: "catalog.pricing",
        hasPricing: true,
        missingFields: [],
      }),
      priceQuote: Object.freeze({
        status: "resolved",
        durationDays: 3,
        dailyRate: 5000,
        total: 15000,
        currency: "PKR",
        source: "catalog_daily_x_duration",
      }),
    }, {
      id: COROLLA_ID,
      displayLabel: "Toyota corolla (Metallic Grey)",
    }),
  });
  assert.equal(plan.actions[0]?.payload?.source, "canonical_verified_price_quote");
  assert.match(String(plan.replyDraft ?? ""), /15,000 PKR/i);
});

test("12: v2 still bypasses legacy", async () => {
  enableV2LiveEnv();
  const result = await runBrainV2LivePipeline({
    traceId: "phase2c-legacy-bypass",
    businessId: BUSINESS_ID,
    message: "Civic 3 din ka rent kitna hai?",
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-1",
    getBookingsForItemFn: async () => [],
  });
  assert.equal(result.legacyBypassed, true);
  assert.equal(isEmilyBrainV2LiveQuickGate(BUSINESS_ID), true);
});

test("13: brain module has no OpenAI imports", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
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
  for (const file of await walk(brainRoot)) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /from\s+["']openai/i, `OpenAI import in ${file}`);
  }
});

test("14: booking/owner/DM execution remains disabled in flags", () => {
  assert.equal(flags.bookingExecute, false);
  assert.equal(flags.ownerExecute, false);
  assert.equal(flags.dmExecute, false);
});

test("15: buildPricingReplyFromCanonical matches summary copy shape", () => {
  const reply = buildPricingReplyFromCanonical("Honda Civic 2026 Oriel (White)", {
    status: "resolved",
    daily: 8000,
    monthly: 165000,
    currency: "PKR",
    hasPricing: true,
  });
  assert.match(reply, /ka rent 8,000 PKR per day aur 165,000 PKR per month hai/i);
});
