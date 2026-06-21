import test from "node:test";
import assert from "node:assert/strict";

import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";
import {
  executeWhatsAppAiPipeline,
  isEmilyBrainV2ShadowQuickGate,
  prepareEmilyBrainV2ShadowMemorySnapshot,
  scheduleEmilyBrainV2ShadowAfterLegacy,
} from "../src/services/whatsappInboundBuffer.js";

const BUSINESS_ID = "synthetic-shadow-business-001";
const envKeys = [
  "NODE_ENV",
  "EMILY_BRAIN_V2_SHADOW",
  "EMILY_BRAIN_V2_SHADOW_BUSINESSES",
  "EMILY_BRAIN_V2_SHADOW_ALLOW_PRODUCTION",
];
const envBackup = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

test.afterEach(() => {
  for (const key of envKeys) {
    const value = envBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("shadow wiring defaults off and empty allowlist stays off", () => {
  delete process.env.EMILY_BRAIN_V2_SHADOW;
  delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;
  assert.equal(isEmilyBrainV2ShadowQuickGate(BUSINESS_ID), false);

  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  assert.equal(isEmilyBrainV2ShadowQuickGate(BUSINESS_ID), false);
});

test("non-allowlisted business cannot schedule shadow", async () => {
  process.env.NODE_ENV = "test";
  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES = "different-business-002";
  const eligible = isEmilyBrainV2ShadowQuickGate(BUSINESS_ID);
  let loaderCalls = 0;
  const scheduled = await scheduleEmilyBrainV2ShadowAfterLegacy({
    shadowEligible: eligible,
    params: { traceId: "not-allowed", businessId: BUSINESS_ID },
    loadShadowModule: async () => {
      loaderCalls += 1;
      throw new Error("must_not_load");
    },
  });

  assert.equal(eligible, false);
  assert.equal(scheduled, false);
  assert.equal(loaderCalls, 0);
});

test("production requires explicit shadow production permission", () => {
  process.env.NODE_ENV = "production";
  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES = BUSINESS_ID;
  delete process.env.EMILY_BRAIN_V2_SHADOW_ALLOW_PRODUCTION;
  assert.equal(isEmilyBrainV2ShadowQuickGate(BUSINESS_ID), false);

  process.env.EMILY_BRAIN_V2_SHADOW_ALLOW_PRODUCTION = "true";
  assert.equal(isEmilyBrainV2ShadowQuickGate(BUSINESS_ID), true);
});

test("pre-legacy snapshot does not initialize a missing session", async () => {
  const sessionKey = `missing-shadow-session-${Date.now()}-${Math.random()}`;
  assert.equal(peekEmilySessionState(sessionKey), null);

  const snapshot = await prepareEmilyBrainV2ShadowMemorySnapshot({
    shadowEligible: true,
    traceId: "snapshot-read-only",
    businessId: BUSINESS_ID,
    sessionKey,
    resolveSessionKey: () => sessionKey,
  });

  assert.equal(snapshot, null);
  assert.equal(peekEmilySessionState(sessionKey), null);
});

test("disabled shadow preparation loads nothing and mutates nothing", async () => {
  let dependencyCalls = 0;
  const snapshot = await prepareEmilyBrainV2ShadowMemorySnapshot({
    shadowEligible: false,
    businessId: BUSINESS_ID,
    loadShadowModule: async () => {
      dependencyCalls += 1;
      throw new Error("must_not_load");
    },
    peekSessionState: () => {
      dependencyCalls += 1;
      throw new Error("must_not_peek");
    },
  });

  assert.equal(snapshot, null);
  assert.equal(dependencyCalls, 0);
});

test("shadow scheduling is positioned only after legacy processMessage resolves", () => {
  const source = executeWhatsAppAiPipeline.toString();
  const legacyCall = source.indexOf("await processMessage({");
  const shadowCall = source.indexOf("await scheduleEmilyBrainV2ShadowAfterLegacy({");

  assert.ok(legacyCall >= 0, "legacy processMessage call must exist");
  assert.ok(shadowCall > legacyCall, "shadow scheduling must follow legacy processing");
});

test("shadow scheduler failure is swallowed and returns control", async () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args);
  try {
    const result = await scheduleEmilyBrainV2ShadowAfterLegacy({
      shadowEligible: true,
      params: { traceId: "shadow-failure", businessId: BUSINESS_ID },
      loadShadowModule: async () => ({
        scheduleEmilyBrainV2ShadowEvaluation: async () => {
          throw new Error("synthetic_shadow_timeout");
        },
      }),
    });

    assert.equal(result, false);
    assert.equal(logs.some(([label]) => label === "[emily_brain_shadow_schedule_failed]"), true);
  } finally {
    console.log = originalLog;
  }
});

test("shadow wiring helpers invoke no send, booking, notification, ledger, or cursor API", async () => {
  const calls = [];
  const existing = { lastItem: { id: "fixture-item" } };
  const snapshot = await prepareEmilyBrainV2ShadowMemorySnapshot({
    shadowEligible: true,
    businessId: BUSINESS_ID,
    resolveSessionKey: () => "existing-session",
    peekSessionState: () => existing,
  });
  const scheduled = await scheduleEmilyBrainV2ShadowAfterLegacy({
    shadowEligible: true,
    params: { traceId: "safe-shadow", businessId: BUSINESS_ID },
    loadShadowModule: async () => ({
      scheduleEmilyBrainV2ShadowEvaluation: () => calls.push("shadow_schedule"),
    }),
  });

  snapshot.lastItem.id = "snapshot-only-change";
  assert.equal(existing.lastItem.id, "fixture-item");
  assert.equal(scheduled, true);
  assert.deepEqual(calls, ["shadow_schedule"]);
});
