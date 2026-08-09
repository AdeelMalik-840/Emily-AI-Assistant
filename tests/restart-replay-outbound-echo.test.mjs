import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

const {
  isLikelyAssistantOutboundCopy,
  filterGuaranteeFirstEligibleUserRows,
  buildStableMessageKey,
} = await import("../src/services/playwrightListener/listener.js");
const {
  isEmilyAssistantPricingStatement,
  resolveInboundSourceOrigin,
  shouldBlockBookingForAssistantOrigin,
  validateOutboundReplyBinding,
  INBOUND_SOURCE_REAL_CUSTOMER,
  INBOUND_SOURCE_ASSISTANT_TEMPLATE,
} = await import("../src/services/inboundOriginGuard.js");
const {
  registerPlaywrightOutboundChunks,
  isRegisteredPlaywrightOutboundEcho,
  __clearPlaywrightOutboundRegistryForTests,
} = await import("../src/services/playwrightOutboundRegistry.js");
const { resolveCurrentTurnAuthority } = await import(
  "../src/services/currentTurnAuthority.js"
);

const PRICING_REPLY =
  "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga (5,500 PKR per din).";
const BOOKING_ENGAGEMENT =
  "Perfect 👍 Kia Stonic EX Plus 2021 (White Color) 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?";
const CHAT = "car rental queries";

function mkRow({ text, dataId, position }) {
  return {
    sender: "user",
    participantKey: "p1",
    text,
    prePlainText: "[11:23 AM] Adeel: ",
    id: dataId ? { _serialized: dataId } : undefined,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
    sourceMessageIndex: position,
  };
}

// A. Restart replay: old assistant pricing reply visible
test("A: assistant pricing replay is blocked before pipeline", () => {
  const origin = resolveInboundSourceOrigin({ text: PRICING_REPLY, chatKey: CHAT });
  assert.notEqual(origin.sourceOrigin, INBOUND_SOURCE_REAL_CUSTOMER);
  assert.equal(isLikelyAssistantOutboundCopy(PRICING_REPLY), true);
  assert.equal(isEmilyAssistantPricingStatement(PRICING_REPLY), true);
  const booking = shouldBlockBookingForAssistantOrigin({
    message: PRICING_REPLY,
    sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
    chatKey: CHAT,
    itemId: "stonic-1",
    durationDays: 3,
  });
  assert.equal(booking.blocked, true);
});

// B. Real customer asks price
test("B: customer price question is not assistant origin", () => {
  const text = "3 din k lye rent kitna ho ga?";
  assert.equal(isEmilyAssistantPricingStatement(text), false);
  assert.equal(isLikelyAssistantOutboundCopy(text), false);
  const origin = resolveInboundSourceOrigin({ text, chatKey: CHAT });
  assert.equal(origin.sourceOrigin, INBOUND_SOURCE_REAL_CUSTOMER);
});

// C. Assistant pricing must never become booking
test("C: assistant pricing with item+duration+price blocks booking gate", () => {
  const blocked = shouldBlockBookingForAssistantOrigin({
    message: PRICING_REPLY,
    sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
    chatKey: CHAT,
    itemId: "stonic-1",
    durationDays: 3,
  });
  assert.equal(blocked.blocked, true);
});

// D. Startup baseline stable ids are not re-admitted
test("D: guarantee-first drops baseline_seen rows after restart", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const row = mkRow({
    text: PRICING_REPLY,
    dataId: "false_pricing@c.us_R1",
    position: 8,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;
  const st = {
    baselineSeenStableIds: new Set([stableId]),
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
    acknowledgedAnchorIndex: 7,
  };
  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 7,
    resolvedAnchorIndex: 7,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
});

// E. New message after startup baseline is admitted
test("E: post-anchor customer row after baseline is admitted", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const old = mkRow({
    text: "stonic available?",
    dataId: "false_old@c.us_O",
    position: 5,
  });
  const fresh = mkRow({
    text: "3 din k lye",
    dataId: "false_new@c.us_N",
    position: 9,
  });
  const sorted = [old, fresh];
  const st = {
    baselineSeenStableIds: new Set([buildStableMessageKey(old, sorted).id]),
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
    acknowledgedAnchorIndex: 8,
  };
  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 8,
    resolvedAnchorIndex: 8,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "3 din k lye");
});

// F. Outbound echo after send
test("F: registered outbound echo is dropped", () => {
  __clearPlaywrightOutboundRegistryForTests();
  registerPlaywrightOutboundChunks(CHAT, BOOKING_ENGAGEMENT, {
    guaranteeKey: `${CHAT}::wa::echo1`,
    sourceInboundMessageId: "wa::echo1",
  });
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT, BOOKING_ENGAGEMENT), true);
  const origin = resolveInboundSourceOrigin({ text: BOOKING_ENGAGEMENT, chatKey: CHAT });
  assert.notEqual(origin.sourceOrigin, INBOUND_SOURCE_REAL_CUSTOMER);
});

// G. Booking creation source validation
test("G: booking gate requires real_customer_inbound origin", () => {
  const blocked = shouldBlockBookingForAssistantOrigin({
    message: "3 din k lye",
    sourceOrigin: "assistant_outbound_echo",
    itemId: "stonic-1",
    durationDays: 3,
  });
  assert.equal(blocked.blocked, true);
  const allowed = shouldBlockBookingForAssistantOrigin({
    message: "3 din k lye",
    sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
    itemId: "stonic-1",
    durationDays: 3,
  });
  assert.equal(allowed.blocked, false);
});

// H. Stale reply send block
test("H: outbound binding blocks non-customer source", () => {
  const bad = validateOutboundReplyBinding({
    replyToMessageId: "wa::1",
    sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
    textPreview: BOOKING_ENGAGEMENT,
  });
  assert.equal(bad.ok, false);
  const good = validateOutboundReplyBinding({
    replyToMessageId: "wa::1",
    sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
    textPreview: "Ji, available hai",
  });
  assert.equal(good.ok, true);
});

// I. Normal customer duration is not blocked as assistant
test("I: customer duration follow-up is not assistant pricing", () => {
  assert.equal(isLikelyAssistantOutboundCopy("3 din k lye chyh"), false);
  assert.equal(
    shouldBlockBookingForAssistantOrigin({
      message: "3 din k lye chyh",
      sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
      itemId: "stonic-1",
      durationDays: 3,
    }).blocked,
    false
  );
});

// J. Current turn authority still works
test("J: civic beats stale corolla memory", () => {
  const civic = {
    id: "civic-1",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel (White)",
  };
  const corolla = {
    id: "corolla-1",
    name: "Toyota corolla",
    displayLabel: "Toyota corolla (Metallic Grey)",
  };
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "[Adeel malik] civic available?",
    catalogItems: [civic, corolla],
    memory: {
      lastItem: { id: corolla.id, name: corolla.name, displayLabel: corolla.displayLabel },
    },
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
});
