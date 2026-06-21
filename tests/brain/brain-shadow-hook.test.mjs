/**
 * Log-only v2 shadow hook — flag gating, safety, and non-execution guarantees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

import {
  isEmilyBrainV2ShadowEnabled,
  isEmilyBrainV2ShadowEnabledForBusiness,
  getEmilyBrainV2ShadowBusinessAllowlist,
  isEmilyBrainV2ShadowEnvironmentAllowed,
} from "../../src/brain/config/featureFlags.js";
import {
  runEmilyBrainV2ShadowEvaluation,
  scheduleEmilyBrainV2ShadowEvaluation,
  assertShadowActionPlanIsNonExecuting,
  buildShadowTurnContext,
} from "../../src/brain/shadow/brainShadowHook.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  loadSyntheticHotelCatalogFixture,
} from "../../src/brain/golden/goldenHarness.js";
import * as inventoryService from "../../src/services/inventoryService.js";

const SYNTHETIC_CAR_RENTAL_UID = "synthetic-car-rental-business-001";
const SYNTHETIC_HOTEL_UID = "synthetic-hotel-business-001";
const OTHER_BUSINESS_UID = "other-unlisted-business-999";
const fixture = loadSyntheticCarRentalCatalogFixture();
const hotelFixture = loadSyntheticHotelCatalogFixture();

const envBackup = {
  EMILY_BRAIN_V2_SHADOW: process.env.EMILY_BRAIN_V2_SHADOW,
  EMILY_BRAIN_V2_SHADOW_BUSINESSES: process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES,
  EMILY_BRAIN_V2_SHADOW_TIMEOUT_MS: process.env.EMILY_BRAIN_V2_SHADOW_TIMEOUT_MS,
  NODE_ENV: process.env.NODE_ENV,
};

test.after(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.afterEach(() => {
  mock.reset();
});

function enableShadowForSyntheticCarRental() {
  process.env.NODE_ENV = "test";
  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES = SYNTHETIC_CAR_RENTAL_UID;
  process.env.EMILY_BRAIN_V2_SHADOW_TIMEOUT_MS = "5000";
}

function enableShadowForBusinesses(allowlist) {
  process.env.NODE_ENV = "test";
  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES = allowlist;
  process.env.EMILY_BRAIN_V2_SHADOW_TIMEOUT_MS = "5000";
}

/**
 * @param {string} businessId
 * @param {import("../../src/brain/golden/goldenHarness.js").CatalogFixture} catalogFixture
 */
async function runShadowGateProbe(businessId, catalogFixture) {
  let orchestratorCalls = 0;
  const result = await runEmilyBrainV2ShadowEvaluation({
    traceId: `shadow-gate-${businessId}`,
    businessId,
    message: "test inbound",
    chatKey: catalogFixture.groupChatKey,
    participantKey: catalogFixture.participantKey,
    catalogItems: catalogFixture.items,
    __testOrchestratorFn: () => {
      orchestratorCalls += 1;
      return {
        understanding: {},
        workflowDecision: { workflowType: "noop", reason: "test_probe" },
        actionPlan: {
          planId: "probe",
          actions: [{ type: "REPLY", payload: { execute: false } }],
          persistenceIntent: { execute: false },
        },
      };
    },
  });
  return { result, orchestratorCalls };
}

test("shadow flags default OFF", () => {
  delete process.env.EMILY_BRAIN_V2_SHADOW;
  delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;
  assert.equal(isEmilyBrainV2ShadowEnabled(), false);
  assert.deepEqual(getEmilyBrainV2ShadowBusinessAllowlist(), []);
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(SYNTHETIC_CAR_RENTAL_UID), false);
});

test("A: shadow flag OFF returns null without orchestrator evaluation", async () => {
  delete process.env.EMILY_BRAIN_V2_SHADOW;
  delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;

  let orchestratorCalls = 0;
  const result = await runEmilyBrainV2ShadowEvaluation({
    traceId: "shadow-off-1",
    businessId: SYNTHETIC_CAR_RENTAL_UID,
    message: "Civic available?",
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    catalogItems: fixture.items,
    __testOrchestratorFn: () => {
      orchestratorCalls += 1;
      throw new Error("should_not_run_with_shadow_off");
    },
  });

  assert.equal(result, null);
  assert.equal(orchestratorCalls, 0);
});

test("B: shadow ON + empty allowlist returns null without orchestrator evaluation", async () => {
  process.env.EMILY_BRAIN_V2_SHADOW = "true";
  delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;

  let orchestratorCalls = 0;
  const result = await runEmilyBrainV2ShadowEvaluation({
    traceId: "shadow-no-allowlist-1",
    businessId: SYNTHETIC_CAR_RENTAL_UID,
    message: "Civic available?",
    chatKey: fixture.groupChatKey,
    catalogItems: fixture.items,
    __testOrchestratorFn: () => {
      orchestratorCalls += 1;
      throw new Error("should_not_run_without_allowlist");
    },
  });

  assert.equal(result, null);
  assert.equal(orchestratorCalls, 0);
});

test("D: shadow ON + multiple allowlisted business IDs all evaluate", async () => {
  const thirdUid = "shadow-canary-business-003";
  enableShadowForBusinesses(
    `${SYNTHETIC_CAR_RENTAL_UID}, ${SYNTHETIC_HOTEL_UID};${thirdUid}`
  );

  assert.deepEqual(getEmilyBrainV2ShadowBusinessAllowlist(), [
    SYNTHETIC_CAR_RENTAL_UID,
    SYNTHETIC_HOTEL_UID,
    thirdUid,
  ]);
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(SYNTHETIC_CAR_RENTAL_UID), true);
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(SYNTHETIC_HOTEL_UID), true);
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(thirdUid), true);

  for (const [businessId, catalogFixture] of [
    [SYNTHETIC_CAR_RENTAL_UID, fixture],
    [SYNTHETIC_HOTEL_UID, hotelFixture],
    [thirdUid, hotelFixture],
  ]) {
    const { result, orchestratorCalls } = await runShadowGateProbe(businessId, catalogFixture);
    assert.equal(orchestratorCalls, 1, `expected evaluation for ${businessId}`);
    assert.ok(result, `expected shadow result for ${businessId}`);
  }
});

test("E: shadow ON + non-listed business does not evaluate", async () => {
  enableShadowForSyntheticCarRental();
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(OTHER_BUSINESS_UID), false);

  const { result, orchestratorCalls } = await runShadowGateProbe(
    OTHER_BUSINESS_UID,
    hotelFixture
  );
  assert.equal(result, null);
  assert.equal(orchestratorCalls, 0);
});

test("F: synthetic hotel allowlisted shadow evaluates without car-rental catalog", async () => {
  enableShadowForBusinesses(SYNTHETIC_HOTEL_UID);

  let orchestratorInput = null;
  const result = await runEmilyBrainV2ShadowEvaluation({
    traceId: "shadow-hotel-1",
    businessId: SYNTHETIC_HOTEL_UID,
    message: "Deluxe Room available?",
    messageId: "shadow-hotel-1-msg",
    chatKey: hotelFixture.groupChatKey,
    participantKey: hotelFixture.participantKey,
    playwrightWebInbound: true,
    catalogItems: hotelFixture.items,
    __testOrchestratorFn: (input) => {
      orchestratorInput = input;
      return {
        understanding: {
          resolvedItemId: "deluxe_room_fixture_001",
          resolvedItemLabel: "Deluxe Room",
          itemSource: "explicit",
          askedField: "availability",
        },
        workflowDecision: {
          workflowType: "availability_inquiry",
          reason: "explicit_item_availability_question",
        },
        actionPlan: {
          planId: "shadow-hotel-plan",
          replyDraft: "Deluxe Room is available.",
          actions: [
            {
              type: "REPLY",
              payload: { execute: false, text: "Deluxe Room is available." },
            },
          ],
          persistenceIntent: { execute: false },
        },
      };
    },
  });

  assert.ok(result);
  assert.equal(result.businessId, SYNTHETIC_HOTEL_UID);
  assert.equal(result.workflowDecision?.workflowType, "availability_inquiry");
  assert.equal(
    orchestratorInput?.businessContext?.catalogItems?.length,
    hotelFixture.items.length
  );
  assert.equal(
    orchestratorInput?.businessContext?.catalogItems?.[0]?.id,
    "deluxe_room_fixture_001"
  );
  assert.doesNotMatch(String(result.inboundPreview ?? ""), /civic|corolla/i);
});

test("catalog loader uses getCachedItemsForUser by businessId when items not injected", async () => {
  enableShadowForBusinesses(SYNTHETIC_HOTEL_UID);

  await inventoryService.setCachedItemsForUser(SYNTHETIC_HOTEL_UID, hotelFixture.items);

  let orchestratorInput = null;
  try {
    const result = await runEmilyBrainV2ShadowEvaluation({
      traceId: "shadow-catalog-loader-1",
      businessId: SYNTHETIC_HOTEL_UID,
      message: "Deluxe Room available?",
      chatKey: hotelFixture.groupChatKey,
      participantKey: hotelFixture.participantKey,
      __testOrchestratorFn: (input) => {
        orchestratorInput = input;
        return {
          understanding: {
            resolvedItemId: "deluxe_room_fixture_001",
            itemSource: "explicit",
          },
          workflowDecision: { workflowType: "availability_inquiry", reason: "test" },
          actionPlan: {
            planId: "shadow-catalog-loader-plan",
            actions: [{ type: "REPLY", payload: { execute: false } }],
            persistenceIntent: { execute: false },
          },
        };
      },
    });

    assert.ok(result);
    assert.equal(
      orchestratorInput?.businessContext?.catalogItems?.[0]?.id,
      "deluxe_room_fixture_001"
    );
  } finally {
    inventoryService.invalidateItemsCacheForUser(SYNTHETIC_HOTEL_UID);
  }
});

test("C: shadow ON + allowlisted runs v2 orchestrator and logs decision", async () => {
  enableShadowForSyntheticCarRental();
  assert.equal(isEmilyBrainV2ShadowEnvironmentAllowed(), true);
  assert.equal(
    isEmilyBrainV2ShadowEnabledForBusiness(SYNTHETIC_CAR_RENTAL_UID),
    true
  );

  let orchestratorCalls = 0;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    if (String(args[0] ?? "") === "[emily_brain_shadow]") {
      logs.push(args[1]);
    }
    originalLog(...args);
  };

  try {
    const result = await runEmilyBrainV2ShadowEvaluation({
      traceId: "shadow-on-1",
      businessId: SYNTHETIC_CAR_RENTAL_UID,
      message: "Civic available?",
      messageId: "shadow-on-1-msg",
      chatKey: fixture.groupChatKey,
      participantKey: fixture.participantKey,
      playwrightWebInbound: true,
      catalogItems: fixture.items,
      legacyOutcome: {
        reply: "legacy reply",
        messageMeta: {
          outboundTrace: { finalReplySource: "INFORMATIONAL_COMPOSER" },
        },
      },
      __testOrchestratorFn: () => {
        orchestratorCalls += 1;
        return {
          understanding: {
            resolvedItemId: "honda_civic_2026_oriel_white_7e961e31",
            resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
            itemSource: "explicit",
            askedField: "availability",
          },
          workflowDecision: {
            workflowType: "availability_inquiry",
            reason: "explicit_item_availability_question",
          },
          actionPlan: {
            planId: "shadow-plan-1",
            replyDraft: "Ji, Civic available hai.",
            actions: [
              {
                type: "REPLY",
                payload: { execute: false, text: "Ji, Civic available hai." },
              },
            ],
            persistenceIntent: { execute: false },
          },
        };
      },
    });

    assert.equal(orchestratorCalls, 1);
    assert.ok(result);
    assert.equal(result.workflowDecision?.workflowType, "availability_inquiry");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.stage, "complete");
    assert.equal(logs[0]?.understanding?.resolvedItemId, "honda_civic_2026_oriel_white_7e961e31");
    assert.equal(logs[0]?.actionPlan?.executeFlags?.every((v) => v === false), true);
  } finally {
    console.log = originalLog;
  }
});

test("shadow evaluation error does not throw from scheduler", async () => {
  enableShadowForSyntheticCarRental();

  await assert.doesNotReject(async () => {
    scheduleEmilyBrainV2ShadowEvaluation({
      traceId: "shadow-error-1",
      businessId: SYNTHETIC_CAR_RENTAL_UID,
      message: "Civic available?",
      chatKey: fixture.groupChatKey,
      catalogItems: fixture.items,
      __testOrchestratorFn: () => {
        throw new Error("shadow_orchestrator_boom");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

test("booking/owner action plans remain execute:false in real orchestrator path", async () => {
  enableShadowForSyntheticCarRental();

  const { runConversationTurn } = await import(
    "../../src/brain/orchestrator/ConversationOrchestrator.js"
  );
  const { buildShadowAdmittedTurn } = await import(
    "../../src/brain/shadow/brainShadowHook.js"
  );
  const { buildCollectDurationTurnContext } = await import(
    "../../src/brain/golden/goldenHarness.js"
  );

  const turnContext = buildCollectDurationTurnContext({
    fixture,
    firstUserMessage: "Corolla available?",
    itemId: "toyota_corolla_metallic_grey_fixture",
  });
  const admittedTurn = buildShadowAdmittedTurn({
    traceId: "shadow-booking-plan",
    businessId: SYNTHETIC_CAR_RENTAL_UID,
    message: "3 din k lye",
    messageId: "shadow-booking-plan-msg",
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
  });

  const result = runConversationTurn({
    traceId: "shadow-booking-plan::shadow",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: fixture.items },
  });

  assert.equal(result.workflowDecision.workflowType, "booking_request");
  assert.doesNotThrow(() => assertShadowActionPlanIsNonExecuting(result.actionPlan));
  const actions = result.actionPlan?.actions ?? [];
  assert.ok(actions.some((a) => a.type === "CREATE_BOOKING"));
  assert.ok(actions.some((a) => a.type === "NOTIFY_OWNER"));
  for (const action of actions) {
    assert.equal(action.payload?.execute, false);
  }
});

test("shadow turn context builder clones memory without writing session/ledger", async () => {
  enableShadowForSyntheticCarRental();

  const memorySnapshot = {
    lastItem: { id: "old-item", name: "Old" },
    pendingAction: { type: "collect_duration", itemId: "old-item" },
  };

  const context = buildShadowTurnContext({
    businessId: SYNTHETIC_CAR_RENTAL_UID,
    sessionKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    playwrightChatKey: fixture.groupChatKey,
    isGroupInbound: true,
    memorySnapshot,
  });

  context.memorySnapshot.lastItem = { id: "mutated", name: "Mutated" };
  assert.equal(memorySnapshot.lastItem.id, "old-item");

  await runEmilyBrainV2ShadowEvaluation({
    traceId: "shadow-no-write-1",
    businessId: SYNTHETIC_CAR_RENTAL_UID,
    message: "Civic available?",
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    memorySnapshot,
    playwrightWebInbound: true,
    catalogItems: fixture.items,
  });
});

test("sample shadow log shape for Civic availability", async () => {
  enableShadowForSyntheticCarRental();

  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => {
    if (String(args[0] ?? "") === "[emily_brain_shadow]") captured.push(args[1]);
    originalLog(...args);
  };

  try {
    await runEmilyBrainV2ShadowEvaluation({
      traceId: "shadow-sample-1",
      businessId: SYNTHETIC_CAR_RENTAL_UID,
      message: "Civic available?",
      messageId: "shadow-sample-msg",
      chatKey: fixture.groupChatKey,
      participantKey: fixture.participantKey,
      playwrightWebInbound: true,
      catalogItems: fixture.items,
      legacyOutcome: {
        reply: "Ji, available hai. Kitne din ke liye chahiye?",
        messageMeta: {
          outboundTrace: { finalReplySource: "COLLECT_DURATION_PROMPT" },
          routeType: "INFORMATIONAL_QUESTION",
        },
      },
    });

    assert.equal(captured.length, 1);
    const log = captured[0];
    assert.equal(log.stage, "complete");
    assert.equal(log.traceId, "shadow-sample-1");
    assert.equal(log.businessId, SYNTHETIC_CAR_RENTAL_UID);
    assert.equal(log.inboundPreview, "Civic available?");
    assert.equal(log.admission.admitted, true);
    assert.equal(log.workflowDecision.workflowType, "availability_inquiry");
    assert.deepEqual(log.actionPlan.actionTypes, ["REPLY"]);
  } finally {
    console.log = originalLog;
  }
});
