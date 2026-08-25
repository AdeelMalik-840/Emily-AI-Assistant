import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "semantic-authority-biz";

const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  getCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

const transactionalIntents = [
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
  "browse_options",
  "clarification",
];

function withLedger(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-semantic-ledger-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  return Promise.resolve()
    .then(fn)
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function identityFor(suffix) {
  return buildCloudInboundLifecycleIdentity({
    businessId: "semantic-authority-biz",
    customerPhone: "923001234567",
    messageId: `wamid.${suffix}`,
  });
}

function persistReleased(identity, semanticIntent) {
  const itemScope = semanticIntent === "browse_options" ? "broad" :
    ["clarification", "unclear", "general_business_question"].includes(semanticIntent)
      ? "none"
      : "specific";
  const itemReferents = itemScope === "specific"
    ? [{ source: "current_turn", surfaceText: "item", start: 0, end: 4, trustedItemId: null, sourceTurnId: null }]
    : [];
  return persistCloudInboundSemanticDecision({
    identity,
    messageId: identity.stableId,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
    openaiSource: "openai",
    decision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent,
      itemScope,
      itemReferents,
      targetId: null,
      targetContext: "NEW_TRANSACTION",
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
    },
  });
}

test("ledger preserves valid NEW_TRANSACTION semantic intents without mutation", async () => {
  await withLedger(() => {
    for (const semanticIntent of transactionalIntents) {
      const identity = identityFor(`round-trip-${semanticIntent}`);
      const persisted = persistReleased(identity, semanticIntent);
      assert.equal(persisted.ok, true, semanticIntent);
      assert.equal(persisted.decision.semanticIntent, semanticIntent, semanticIntent);
      assert.equal(
        getCloudInboundSemanticDecision({ identity }).semanticIntent,
        semanticIntent,
        semanticIntent
      );
    }
  });
});

test("ledger semantic identity is idempotent and rejects semantic-intent rewrites", async () => {
  await withLedger(() => {
    const identity = identityFor("write-once");
    assert.equal(persistReleased(identity, "browse_options").ok, true);
    const same = persistReleased(identity, "browse_options");
    assert.equal(same.ok, true);
    assert.equal(same.reason, "already_accepted");
    const changed = persistReleased(identity, "availability_inquiry");
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    assert.equal(
      getCloudInboundSemanticDecision({ identity }).semanticIntent,
      "browse_options"
    );
  });
});

test("ledger preserves item scope and rejects scope mutation", async () => {
  await withLedger(() => {
    const identity = identityFor("item-scope-write-once");
    const first = persistReleased(identity, "availability_inquiry");
    assert.equal(first.ok, true);
    assert.equal(first.decision.itemScope, "specific");
    assert.equal(getCloudInboundSemanticDecision({ identity }).itemScope, "specific");
    const same = persistReleased(identity, "availability_inquiry");
    assert.equal(same.ok, true);
    assert.equal(same.reason, "already_accepted");
    const changed = persistCloudInboundSemanticDecision({
      identity,
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
      openaiSource: "openai",
      decision: {
        turnScope: "NEW_TRANSACTION",
        semanticIntent: "browse_options",
        itemScope: "broad",
        itemReferents: [],
        targetId: null,
        mutationIntent: "none",
        action: "reply",
        factKind: "booking_fact",
      },
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    assert.equal(getCloudInboundSemanticDecision({ identity }).itemScope, "specific");
  });
});

test("ledger enforces scope-aware semantic-intent validation without reconstruction", async () => {
  await withLedger(() => {
    const persistScope = (suffix, turnScope, semanticIntent, include = true) => {
      const identity = identityFor(suffix);
      const decision = {
        turnScope,
        itemReferents: [],
        targetId: null,
        mutationIntent: "none",
        action: "reply",
        factKind: "booking_fact",
      };
      if (include) decision.semanticIntent = semanticIntent;
      if (turnScope === "NEW_TRANSACTION") {
        decision.itemScope = semanticIntent === "browse_options" ? "broad" : "specific";
      }
      if (turnScope === "OLD_BOOKING_REFERENCE") {
        decision.targetReference = {
          source: "current_turn",
          sourceTurnId: `user:${suffix}`,
          targetType: "historical_booking",
          targetId: null,
        };
      }
      return persistCloudInboundSemanticDecision({
        identity,
        decision,
        semanticDecisionStatus:
          turnScope === "NEW_TRANSACTION" ||
          turnScope === "SOCIAL_GENERAL" ||
          turnScope === "UNCLEAR"
            ? "released"
            : "accepted",
        ownershipLane:
          turnScope === "PENDING_AVAILABILITY_REFERENCE"
            ? "waiting_confirm_dm"
            : turnScope === "OLD_BOOKING_REFERENCE"
              ? "post_confirm_pa"
              : "normal_routing",
        openaiSource: "openai",
      });
    };

    assert.equal(persistScope("new-missing", "NEW_TRANSACTION", null, false).ok, false);
    assert.equal(persistScope("new-null", "NEW_TRANSACTION", null).ok, false);
    assert.equal(persistScope("new-invalid", "NEW_TRANSACTION", "made_up").ok, false);
    assert.equal(persistScope("social", "SOCIAL_GENERAL", "social").ok, true);
    assert.equal(persistScope("social-wrong", "SOCIAL_GENERAL", "unclear").ok, false);
    assert.equal(persistScope("unclear", "UNCLEAR", "unclear").ok, true);
    assert.equal(persistScope("unclear-wrong", "UNCLEAR", "social").ok, false);
    assert.equal(
      persistScope("pending-null", "PENDING_AVAILABILITY_REFERENCE", null).ok,
      true
    );
    assert.equal(
      persistScope("old-null", "OLD_BOOKING_REFERENCE", null).ok,
      true
    );
    assert.equal(
      persistScope(
        "pending-valid",
        "PENDING_AVAILABILITY_REFERENCE",
        "availability_inquiry"
      ).decision.semanticIntent,
      "availability_inquiry"
    );
    assert.equal(
      persistScope("old-valid", "OLD_BOOKING_REFERENCE", "pricing_inquiry")
        .decision.semanticIntent,
      "pricing_inquiry"
    );
    assert.equal(
      persistScope("pending-invalid", "PENDING_AVAILABILITY_REFERENCE", "made_up").ok,
      false
    );
    assert.equal(
      persistScope("old-invalid", "OLD_BOOKING_REFERENCE", "made_up").ok,
      false
    );
    assert.equal(
      persistScope("historical-new", "NEW_TRANSACTION", null, false).reason,
      "INVALID_SEMANTIC_DECISION"
    );
    const historicalProtected = persistScope(
      "historical-old-no-scope",
      "OLD_BOOKING_REFERENCE",
      null
    );
    assert.equal(historicalProtected.ok, true);
    assert.equal(historicalProtected.decision.itemScope, null);
  });
});

test("real ledger snapshot binds browse and availability intents into Brain V2", async () => {
  await withLedger(async () => {
    for (const semanticIntent of ["browse_options", "availability_inquiry"]) {
      const identity = identityFor(`pipeline-${semanticIntent}`);
      assert.equal(persistReleased(identity, semanticIntent).ok, true);
      const frozen = getCloudInboundSemanticDecision({ identity });
      assert.equal(frozen.semanticIntent, semanticIntent);
      let observedIntent = null;
      const workflowType =
        semanticIntent === "browse_options" ? "browse_options" : "availability_inquiry";
      const result = await runBrainV2LivePipeline({
        traceId: `ledger-pipeline-${semanticIntent}`,
        businessId: "semantic-authority-biz",
        message: "conflicting downstream text",
        messageId: identity.stableId,
        channel: "whatsapp_cloud",
        chatType: "dm",
        isGroupInbound: false,
        catalogItems: [{ id: "civic", name: "Honda Civic", isAvailable: true }],
        canonicalSemanticDecision: frozen,
        executionContext: { db: {} },
        getBookingsForItemFn: async () => [],
        getBusinessProfileFn: async () => ({}),
        __testOrchestratorFn: (input) => {
          observedIntent = input.turnContext.authoritativeSemanticIntent;
          const replyDraft = "Safe test reply.";
          return {
            workflowDecision: { workflowType, reason: "test" },
            actionPlan: {
              workflowType,
              replyDraft,
              actions: [{ type: "REPLY", payload: { text: replyDraft } }],
            },
            trace: {},
          };
        },
      });
      assert.equal(observedIntent, semanticIntent);
      assert.notEqual(result.reason, "CANONICAL_SEMANTIC_INTENT_INVALID");
    }
  });
});
