import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { ITEMLESS_PRICE_CLARIFICATION_REPLY } = await import(
  "../src/services/turnContextAuthority.js"
);
const {
  resolveTrustedPreviousItemContinuation:
    __hasSafePreviousCatalogItemForPriceFollowupForTests,
} = await import(
  "../src/brain/context/previousItemContinuationResolver.js"
);

const BUSINESS_ID = "dm-pricing-business";
const PARTICIPANT_KEY = "dm::adeel-malik";
const SESSION_KEY = `${BUSINESS_ID}::dm::adeel-malik`;

const baseCatalog = [
  {
    id: "civic-1",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
    pricing: { daily: "6500 PKR", monthly: "150000 PKR" },
  },
  {
    id: "corolla-1",
    name: "Toyota Corolla 2024",
    displayLabel: "Toyota Corolla 2024",
    pricing: { daily: "5000 PKR", monthly: "120000 PKR" },
  },
];

const dmTrustedMemory = {
  lastItem: {
    id: "civic-1",
    itemId: "civic-1",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
  },
  lastResolvedItemId: "civic-1",
  stage: "START",
};

async function runDmPricingTurn({
  message,
  memorySnapshot = null,
  catalogItems = baseCatalog,
}) {
  return runBrainV2LivePipeline({
    traceId: `trace-${Math.random().toString(36).slice(2)}`,
    businessId: BUSINESS_ID,
    message,
    messageId: `msg-${Date.now()}`,
    channel: "whatsapp_web",
    chatType: "dm",
    chatId: "dm::adeel-malik",
    sessionKey: SESSION_KEY,
    participantKey: PARTICIPANT_KEY,
    participantName: "Adeel Malik",
    participantDisplayName: "Adeel Malik",
    playwrightChatKey: "adeel-malik",
    isGroupInbound: false,
    isGroupMessage: false,
    playwrightWebInbound: true,
    memorySnapshot,
    catalogItems,
    resolveTrustedSessionItem: (trustedArgs) =>
      __hasSafePreviousCatalogItemForPriceFollowupForTests(trustedArgs),
    executionContext: {
      traceId: "dm-pricing-test",
      businessId: BUSINESS_ID,
      userId: BUSINESS_ID,
      sessionKey: SESSION_KEY,
      participantKey: PARTICIPANT_KEY,
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });
}

function assertNoBookingOrOwner(meta) {
  assert.ok(!meta?.bookingCreated, "booking should not be created");
  const actions = meta?.actionPlan?.actions ?? [];
  const types = actions.map((action) => String(action?.type ?? ""));
  assert.equal(types.includes("CREATE_BOOKING"), false);
  assert.equal(types.includes("NOTIFY_OWNER"), false);
}

function assertPricingReply(result) {
  assert.equal(
    result.messageMeta?.outboundTrace?.brainV2WorkflowType,
    "pricing_with_duration"
  );
  assert.match(result.reply, /civic/i);
  assert.match(result.reply, /6[, ]?500/i);
  assert.match(result.reply, /pkr/i);
  assertNoBookingOrOwner(result.messageMeta);
}

test("DM pricing follow-up with exact item resolves Civic price", async () => {
  const result = await runDmPricingTurn({
    message: "1 din ka rent kitna ha civic ka?",
  });

  assertPricingReply(result);
});

test("DM pricing follow-up with typo resolves Civic when unambiguous", async () => {
  const result = await runDmPricingTurn({
    message: "1 din ka rent kitna ha ciivic ka?",
  });

  assertPricingReply(result);
});

test("DM pricing follow-up uses trusted handoff context when item is missing", async () => {
  const result = await runDmPricingTurn({
    message: "1 din ka rent kitna ha?",
    memorySnapshot: dmTrustedMemory,
  });

  assertPricingReply(result);
});

test("DM pricing follow-up without item and without context asks for clarification", async () => {
  const result = await runDmPricingTurn({
    message: "1 din ka rent kitna ha?",
    memorySnapshot: null,
  });

  assert.equal(result.reply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
  assertNoBookingOrOwner(result.messageMeta);
});

test("DM pricing follow-up with ambiguous typo asks for clarification", async () => {
  const ambiguousCatalog = [
    ...baseCatalog,
    {
      id: "civic-2",
      name: "Honda Civic 2025 RS",
      displayLabel: "Honda Civic 2025 RS",
      pricing: { daily: "7200 PKR", monthly: "165000 PKR" },
    },
  ];
  const result = await runDmPricingTurn({
    message: "1 din ka rent kitna ha ciivic ka?",
    catalogItems: ambiguousCatalog,
  });

  assert.equal(result.reply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
  assertNoBookingOrOwner(result.messageMeta);
});
