import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
  hasAcceptedCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

const BUSINESS_ID = "biz-semantic-resume";
const CUSTOMER_PHONE = "923001234567";
const MESSAGE_ID = "wamid.semantic-resume-civic";

function withLedger(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-semantic-resume-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

function civicFacts() {
  const stonic = {
    id: "booking-stonic-old",
    selectionIndex: 1,
    itemId: "kia-stonic",
    itemLabel: "Kia Stonic",
    status: "approved",
    durationDays: 4,
  };
  const civic = {
    id: "E55qPBHJUW1NsUvNLAhH",
    selectionIndex: 2,
    itemId: "honda-civic",
    itemLabel: "Honda Civic",
    status: "approved",
    durationDays: 5,
  };
  return {
    booking: civic,
    bookingCandidates: [stonic, civic],
    activeBookings: [stonic, civic],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 2,
      selectedBookingId: civic.id,
      bookingId: civic.id,
      itemId: civic.itemId,
      itemLabel: civic.itemLabel,
    },
    pendingAvailabilityRequests: [],
    known: {},
    policy: { readOnly: true },
  };
}

test("timeout before accepted decision may decide on retry", async () => {
  await withLedger(async () => {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    let decideCalls = 0;
    const first = await handleCustomerBusinessPaInbound({
      db: {},
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Honda Civic 3 din k liye chahiye",
      messageId: MESSAGE_ID,
      cloudLifecycleIdentity: identity,
      __resolveActiveCustomerBookingFactsFn: async () => ({
        ok: true,
        facts: civicFacts(),
      }),
      __decideCustomerTurnFn: async () => {
        decideCalls += 1;
        return {
          ok: false,
          retryable: true,
          source: "technical_fallback",
          reason: "POST_CONFIRM_CUSTOMER_DM_OPENAI_TIMEOUT",
          decision: {},
        };
      },
    });
    assert.equal(first.retryable, true);
    assert.equal(hasAcceptedCloudInboundSemanticDecision({ identity }), false);
    assert.equal(decideCalls, 1);

    const second = await handleCustomerBusinessPaInbound({
      db: {},
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Honda Civic 3 din k liye chahiye",
      messageId: MESSAGE_ID,
      cloudLifecycleIdentity: identity,
      __resolveActiveCustomerBookingFactsFn: async () => ({
        ok: true,
        facts: civicFacts(),
      }),
      __decideCustomerTurnFn: async () => {
        decideCalls += 1;
        return {
          ok: true,
          source: "openai",
          decision: {
            turnScope: "NEW_TRANSACTION",
            targetId: null,
            action: "reply",
            mutationIntent: "none",
            factKind: "booking_fact",
            capability: "availability_request",
          },
        };
      },
    });
    assert.equal(decideCalls, 2);
    assert.equal(second.ownershipReleased, true);
    assert.equal(second.decision.turnScope, "NEW_TRANSACTION");
    assert.equal(
      getCloudInboundSemanticDecision({ identity })?.semanticDecisionStatus,
      "released"
    );
  });
});

test("retry after accepted decision reuses snapshot and does not call semantic OpenAI", async () => {
  await withLedger(async () => {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    let decideCalls = 0;
    const params = {
      db: {},
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Honda Civic 3 din k liye chahiye",
      messageId: MESSAGE_ID,
      cloudLifecycleIdentity: identity,
      __resolveActiveCustomerBookingFactsFn: async () => ({
        ok: true,
        facts: civicFacts(),
      }),
      __decideCustomerTurnFn: async () => {
        decideCalls += 1;
        return {
          ok: true,
          source: "openai",
          decision: {
            turnScope: "NEW_TRANSACTION",
            targetId: null,
            action: "reply",
            mutationIntent: "none",
            factKind: "booking_fact",
            capability: "availability_request",
          },
        };
      },
    };
    const first = await handleCustomerBusinessPaInbound(params);
    assert.equal(first.ownershipReleased, true);
    assert.equal(decideCalls, 1);
    const saved = getCloudInboundSemanticDecision({ identity });
    assert.equal(saved.turnScope, "NEW_TRANSACTION");
    assert.equal(saved.semanticDecisionStatus, "released");

    const second = await handleCustomerBusinessPaInbound(params);
    assert.equal(decideCalls, 1);
    assert.equal(second.ownershipReleased, true);
    assert.equal(second.decision.turnScope, "NEW_TRANSACTION");
    assert.equal(second.decision.targetId, null);
  });
});

test("write-once semantic snapshot rejects contradictory rewrite", async () => {
  await withLedger(async () => {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
    });
    const first = persistCloudInboundSemanticDecision({
      identity,
      messageId: MESSAGE_ID,
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
      openaiSource: "openai",
      decision: {
        turnScope: "NEW_TRANSACTION",
        targetId: null,
        action: "reply",
        mutationIntent: "none",
        factKind: "booking_fact",
      },
    });
    assert.equal(first.ok, true);
    const second = persistCloudInboundSemanticDecision({
      identity,
      messageId: MESSAGE_ID,
      semanticDecisionStatus: "accepted",
      ownershipLane: "post_confirm_pa",
      openaiSource: "openai",
      decision: {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: "E55qPBHJUW1NsUvNLAhH",
        action: "reply",
        mutationIntent: "none",
        factKind: "booking_fact",
      },
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    assert.equal(
      getCloudInboundSemanticDecision({ identity })?.turnScope,
      "NEW_TRANSACTION"
    );
  });
});
