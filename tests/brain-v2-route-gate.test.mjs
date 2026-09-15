import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBrainRouteGate,
  isHardV2LiveMode,
  isLegacyProcessMessageAllowed,
  shouldLogBrainV2ExpectedButNotSelected,
  buildHardBlockedPipelineResult,
  BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY,
  detectHasV2LivePipeline,
} from "../src/brain/live/brainRouteGate.js";
import {
  isEmilyBrainV2LiveQuickGate,
  isLegacyProcessMessageAllowed as bufferLegacyAllowed,
} from "../src/services/whatsappInboundBuffer.js";

const ALLOWLISTED = "afWvEVJnssbbp6Jt2GIu23uCrTF2";
const OTHER = "other-business-id-001";

function hardV2Env(overrides = {}) {
  return {
    NODE_ENV: "production",
    EMILY_BRAIN_V2_LIVE: "true",
    EMILY_BRAIN_V2_LIVE_BUSINESSES: ALLOWLISTED,
    EMILY_BRAIN_V2_PRODUCTION_ALLOW: "true",
    EMILY_BRAIN_V2_LEGACY_FALLBACK: "false",
    EMILY_BRAIN_V2_BOOKING_EXECUTE: "false",
    EMILY_BRAIN_V2_OWNER_EXECUTE: "false",
    EMILY_BRAIN_V2_DM_EXECUTE: "false",
    RAILWAY_ENVIRONMENT: "production",
    ...overrides,
  };
}

test("hard v2 mode flags combine correctly", () => {
  assert.equal(isHardV2LiveMode(hardV2Env()), true);
  assert.equal(isHardV2LiveMode(hardV2Env({ EMILY_BRAIN_V2_LEGACY_FALLBACK: "true" })), false);
  assert.equal(isHardV2LiveMode(hardV2Env({ EMILY_BRAIN_V2_LIVE: "false" })), false);
});

test("allowlisted business in hard v2 mode selects v2_live", () => {
  const env = hardV2Env();
  const gate = evaluateBrainRouteGate({
    businessId: ALLOWLISTED,
    chatId: "group-chat-1",
    env,
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(gate.rejectReason, null);
  assert.equal(gate.businessAllowlisted, true);
});

test("non-allowlisted business with resolved businessId still selects v2_live", () => {
  const gate = evaluateBrainRouteGate({
    businessId: OTHER,
    chatId: "group-chat-1",
    env: hardV2Env(),
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(gate.rejectReason, null);
  assert.equal(gate.businessAllowlisted, false);
  assert.equal(gate.businessHardV2Eligible, true);
  assert.equal(
    isLegacyProcessMessageAllowed({ routeGate: gate, handledByBrainV2Live: false }),
    false
  );
  assert.equal(shouldLogBrainV2ExpectedButNotSelected({ routeGate: gate }), false);
});

test("missing businessId in hard v2 mode is blocked", () => {
  const gate = evaluateBrainRouteGate({
    businessId: "",
    chatId: "group-chat-1",
    env: hardV2Env(),
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "blocked");
  assert.equal(gate.rejectReason, "MISSING_BUSINESS_ID");
  assert.equal(isLegacyProcessMessageAllowed({ routeGate: gate }), false);
});

test("empty allowlist does not block v2 when businessId is present", () => {
  const gate = evaluateBrainRouteGate({
    businessId: OTHER,
    chatId: "group-chat-1",
    env: hardV2Env({ EMILY_BRAIN_V2_LIVE_BUSINESSES: "" }),
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(gate.rejectReason, null);
  assert.equal(gate.allowlistConfigError, false);
  assert.equal(gate.businessHardV2Eligible, true);
  assert.equal(isLegacyProcessMessageAllowed({ routeGate: gate }), false);
});

test("pipeline unavailable → PIPELINE_UNAVAILABLE and blocked in hard v2 mode", () => {
  const gate = evaluateBrainRouteGate({
    businessId: ALLOWLISTED,
    chatId: "group-chat-1",
    env: hardV2Env(),
    hasV2LivePipeline: false,
  });
  assert.equal(gate.selected, "blocked");
  assert.equal(gate.rejectReason, "PIPELINE_UNAVAILABLE");
  assert.equal(
    shouldLogBrainV2ExpectedButNotSelected({ routeGate: gate, handledByBrainV2Live: false }),
    true
  );
});

test("allowlisted hard-v2 business cannot fall back to legacy when v2 selected", () => {
  const gate = evaluateBrainRouteGate({
    businessId: ALLOWLISTED,
    chatId: "group-chat-1",
    env: hardV2Env(),
    hasV2LivePipeline: true,
  });
  assert.equal(
    isLegacyProcessMessageAllowed({
      routeGate: gate,
      handledByBrainV2Live: false,
      handledByBrainV2InfoLive: false,
    }),
    false
  );
});

test("soft mode (legacy fallback true) still selects v2_live and never allows legacy", () => {
  const gate = evaluateBrainRouteGate({
    businessId: OTHER,
    chatId: "group-chat-1",
    env: hardV2Env({ EMILY_BRAIN_V2_LEGACY_FALLBACK: "true" }),
    hasV2LivePipeline: true,
  });
  assert.equal(gate.selected, "v2_live");
  assert.equal(gate.hardV2Mode, false);
  assert.equal(isLegacyProcessMessageAllowed({ routeGate: gate }), false);
});

test("hard blocked pipeline result uses customer-safe copy", () => {
  const blocked = buildHardBlockedPipelineResult(true);
  assert.equal(blocked.reply, BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY);
  assert.match(String(blocked.reply), /request complete nahi ho saki/i);
  assert.doesNotMatch(String(blocked.reply), /system|\bAI\b|model|database|technical/i);
  assert.equal(blocked.legacyBypassed, true);
});

test("detectHasV2LivePipeline is true in this repo", () => {
  assert.equal(detectHasV2LivePipeline(true), true);
  assert.equal(detectHasV2LivePipeline(), true);
});

test("whatsappInboundBuffer source includes route gate logging", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/services/whatsappInboundBuffer.js", import.meta.url),
    "utf8"
  );
  assert.ok(source.includes("[brain_route_gate_evaluated]"));
  assert.ok(source.includes("[brain_v2_expected_but_not_selected]"));
  assert.doesNotMatch(source, /\bprocessMessageFn\b|\bprocessMessage\s*\(/);
});

test("buffer re-exports legacy guard compatible with hard v2 mode", () => {
  const gate = evaluateBrainRouteGate({
    businessId: ALLOWLISTED,
    env: hardV2Env(),
    hasV2LivePipeline: true,
  });
  assert.equal(bufferLegacyAllowed({ routeGate: gate }), false);
});
