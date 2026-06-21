import test from "node:test";
import assert from "node:assert/strict";

import {
  isEmilyBrainV2Enabled,
  isEmilyBrainV2EnabledForBusiness,
  getEmilyBrainV2BusinessAllowlist,
  isEmilyBrainV2ShadowEnabled,
  isEmilyBrainV2ShadowEnabledForBusiness,
} from "../../src/brain/config/featureFlags.js";
import {
  isAdmittedTurn,
  isActionPlan,
  isTurnDecisionTrace,
  WHATSAPP_WEB_CAPABILITIES,
} from "../../src/brain/contracts/index.js";
import {
  createTurnDecisionTrace,
  startTurnDecisionTrace,
  finalizeTurnDecisionTrace,
} from "../../src/brain/observability/turnDecisionTrace.js";

const SYNTHETIC_BUSINESS_UID = "synthetic-car-rental-business-001";
const envBackup = {
  EMILY_BRAIN_V2: process.env.EMILY_BRAIN_V2,
  EMILY_BRAIN_V2_BUSINESSES: process.env.EMILY_BRAIN_V2_BUSINESSES,
  EMILY_BRAIN_V2_SHADOW: process.env.EMILY_BRAIN_V2_SHADOW,
  EMILY_BRAIN_V2_SHADOW_BUSINESSES: process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES,
};

test.after(() => {
  if (envBackup.EMILY_BRAIN_V2 === undefined) delete process.env.EMILY_BRAIN_V2;
  else process.env.EMILY_BRAIN_V2 = envBackup.EMILY_BRAIN_V2;
  if (envBackup.EMILY_BRAIN_V2_BUSINESSES === undefined) {
    delete process.env.EMILY_BRAIN_V2_BUSINESSES;
  } else {
    process.env.EMILY_BRAIN_V2_BUSINESSES = envBackup.EMILY_BRAIN_V2_BUSINESSES;
  }
  if (envBackup.EMILY_BRAIN_V2_SHADOW === undefined) {
    delete process.env.EMILY_BRAIN_V2_SHADOW;
  } else {
    process.env.EMILY_BRAIN_V2_SHADOW = envBackup.EMILY_BRAIN_V2_SHADOW;
  }
  if (envBackup.EMILY_BRAIN_V2_SHADOW_BUSINESSES === undefined) {
    delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;
  } else {
    process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES = envBackup.EMILY_BRAIN_V2_SHADOW_BUSINESSES;
  }
});

test("feature flags default OFF", () => {
  delete process.env.EMILY_BRAIN_V2;
  delete process.env.EMILY_BRAIN_V2_BUSINESSES;
  delete process.env.EMILY_BRAIN_V2_SHADOW;
  delete process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES;
  assert.equal(isEmilyBrainV2Enabled(), false);
  assert.deepEqual(getEmilyBrainV2BusinessAllowlist(), []);
  assert.equal(isEmilyBrainV2EnabledForBusiness(SYNTHETIC_BUSINESS_UID), false);
  assert.equal(isEmilyBrainV2ShadowEnabled(), false);
  assert.equal(isEmilyBrainV2ShadowEnabledForBusiness(SYNTHETIC_BUSINESS_UID), false);
});

test("feature flags respect allowlist when globally on", () => {
  process.env.EMILY_BRAIN_V2 = "true";
  process.env.EMILY_BRAIN_V2_BUSINESSES = SYNTHETIC_BUSINESS_UID;
  assert.equal(isEmilyBrainV2Enabled(), true);
  assert.equal(isEmilyBrainV2EnabledForBusiness(SYNTHETIC_BUSINESS_UID), true);
  assert.equal(isEmilyBrainV2EnabledForBusiness("other-uid"), false);
});

test("contracts and trace helpers validate shapes", () => {
  const trace = startTurnDecisionTrace({
    traceId: "t-contract-1",
    businessId: SYNTHETIC_BUSINESS_UID,
    admittedTurn: {
      turn: {
        turnId: "turn-1",
        businessId: SYNTHETIC_BUSINESS_UID,
        channelId: "whatsapp_web",
        chatKey: "car rental queries",
        participantKey: "customer-alpha::first-seen-1",
        text: "Civic available?",
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: "idem-1",
      admissionReason: "admitted_customer_turn",
    },
  });
  assert.equal(isTurnDecisionTrace(trace), true);
  assert.equal(isAdmittedTurn(trace.admittedTurn), true);
  const finalized = finalizeTurnDecisionTrace(
    createTurnDecisionTrace({
      ...trace,
      workflowDecision: {
        workflowType: "pricing_with_duration",
        reason: "test fixture",
      },
      actionPlan: {
        planId: "plan-1",
        actions: [{ type: "REPLY", payload: { draft: "price" } }],
      },
    })
  );
  assert.equal(isActionPlan(finalized.actionPlan), true);
  assert.ok(finalized.completedAt);
});

test("channel capabilities include Playwright DM and Cloud buttons", () => {
  assert.equal(WHATSAPP_WEB_CAPABILITIES.canReplyPrivately, true);
  assert.equal(WHATSAPP_WEB_CAPABILITIES.supportsOwnerApprovalButtons, false);
});
