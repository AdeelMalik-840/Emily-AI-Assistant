import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  applyPostConfirmDerivedOwnershipMechanics,
  buildCloudDmOwnershipPromptFacts,
  buildNeutralCloudDmOwnershipFacts,
  buildPostConfirmDecideFactsForPrompt,
  CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER,
  validatePostConfirmSemanticOwnership,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { handleAvailabilityCustomerCloudInbound } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);

const STONIC_ID = "MHFaQZBnBVgEeRoCIFQ3";
const CIVIC_OLD_ID = "E55qPBHJUW1NsUvNLAhH";
const AVR_ID = "avr-civic-pending-1";

function historyFacts() {
  const stonic = {
    id: STONIC_ID,
    selectionIndex: 1,
    itemId: "kia-stonic",
    itemLabel: "Kia Stonic",
    status: "approved",
    durationDays: 4,
  };
  const civic = {
    id: CIVIC_OLD_ID,
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
      selectedBookingId: CIVIC_OLD_ID,
      bookingId: CIVIC_OLD_ID,
      itemId: civic.itemId,
      itemLabel: civic.itemLabel,
    },
    pendingAvailabilityRequests: [],
    known: {},
    policy: { readOnly: true },
  };
}

test("neutral packing never pre-owns historical Civic/Stonic or pending AVR", () => {
  const packed = buildPostConfirmDecideFactsForPrompt(
    buildNeutralCloudDmOwnershipFacts(historyFacts(), {
      requestId: AVR_ID,
      itemLabel: "Honda Civic",
    })
  );
  assert.equal(packed.bookingFocus, null);
  assert.equal(packed.booking, null);
  assert.deepEqual(
    packed.bookingCandidates.map((row) => row.role),
    ["historical_candidate", "historical_candidate"]
  );
  assert.equal(packed.pendingAvailabilityRequests[0].requestId, AVR_ID);
  assert.equal(
    packed.pendingAvailabilityRequests[0].role,
    "pending_availability_candidate"
  );
  const blob = JSON.stringify(packed);
  assert.doesNotMatch(blob, /latest_confirmed_linked_avr/);
  assert.doesNotMatch(blob, /"confidence":"trusted"/);
});

test("ownership prompt packing is identity-sorted and never pre-owns", () => {
  const packed = buildCloudDmOwnershipPromptFacts(
    buildNeutralCloudDmOwnershipFacts(historyFacts(), {
      requestId: AVR_ID,
      itemLabel: "Honda Civic",
    })
  );
  assert.equal(packed.candidateOrder, CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER);
  assert.equal(packed.bookingFocus, null);
  assert.equal(packed.booking, null);
  assert.equal(packed.known, null);
  assert.equal(packed.replyGuardFacts, null);
  assert.equal(packed.evidenceAvailability, null);
  assert.deepEqual(
    packed.bookingCandidates.map((row) => row.id),
    [CIVIC_OLD_ID, STONIC_ID]
  );
  assert.equal(packed.bookingCandidates[0].selectionIndex, undefined);
  assert.equal(packed.bookingCandidates[1].selectionIndex, undefined);
  assert.equal(packed.pendingAvailabilityRequests[0].selectionIndex, undefined);
  const blob = JSON.stringify(packed);
  assert.doesNotMatch(blob, /selectionIndex/);
  assert.doesNotMatch(blob, /latest_confirmed_linked_avr/);
  assert.doesNotMatch(blob, /"confidence":"trusted"/);
  assert.doesNotMatch(blob, /current booking/i);
  assert.doesNotMatch(blob, /trusted focus/i);
});

test("fresh Civic independent ask validates as NEW_TRANSACTION with null targetId", () => {
  const facts = buildNeutralCloudDmOwnershipFacts(historyFacts());
  const decision = applyPostConfirmDerivedOwnershipMechanics(
    {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      targetId: null,
      action: "reply",
      mutationIntent: "none",
    },
    facts
  );
  const validation = validatePostConfirmSemanticOwnership(decision, facts);
  assert.equal(validation.ok, true);
  assert.equal(decision.turnScope, "NEW_TRANSACTION");
  assert.equal(decision.targetId, null);
  assert.equal(decision.selectedBookingId, null);
});

test("PA frozen OLD_BOOKING does not call ownership AI or change targetId", async () => {
  let decideCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "905443829990",
    messageText: "Meri Stonic booking ka total rent kitna hai?",
    messageId: "wamid.stonic-fact",
    canonicalSemanticDecision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: STONIC_ID,
      selectedBookingId: STONIC_ID,
      action: "reply",
      mutationIntent: "none",
      factKind: "booking_fact",
      openaiSource: "openai",
    },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: historyFacts(),
    }),
    __decideCustomerTurnFn: async () => {
      decideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          turnScope: "OLD_BOOKING_REFERENCE",
          targetId: CIVIC_OLD_ID,
          action: "reply",
          mutationIntent: "none",
        },
      };
    },
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: "Stonic rent trusted facts se.",
    }),
  });
  assert.equal(decideCalls, 0);
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, STONIC_ID);
  assert.notEqual(result.decision.targetId, CIVIC_OLD_ID);
});

test("waiting-confirm frozen PENDING does not call ownership AI or switch referent", async () => {
  let decideCalls = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "923001111111",
    messageText: "per day kitna hai?",
    messageId: "wamid.pending-price",
    canonicalSemanticDecision: {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: AVR_ID,
      action: "reply",
      mutationIntent: "none",
      customerReply: "Per day quoted amount trusted facts se.",
      shouldReply: true,
    },
    __decideCustomerTurnForTests: async () => {
      decideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          action: "confirm_booking",
          targetId: "some-other-avr",
          targetContext: "confirmed_booking",
        },
      };
    },
  });
  assert.equal(decideCalls, 0);
  assert.equal(result.handled, false);
  assert.equal(result.reason, "CANONICAL_PENDING_TARGET_UNTRUSTED");
});

test("accepted retry does not rewrite a frozen NEW_TRANSACTION snapshot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-cloud-own-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  try {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: "biz-1",
      customerPhone: "923001234567",
      messageId: "wamid.retry-accepted",
    });
    claimCloudInboundTurn({
      businessId: "biz-1",
      customerPhone: "923001234567",
      messageId: "wamid.retry-accepted",
    });
    const first = persistCloudInboundSemanticDecision({
      identity,
      messageId: "wamid.retry-accepted",
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
      openaiSource: "openai",
      decision: {
        turnScope: "NEW_TRANSACTION",
        semanticIntent: "availability_inquiry",
        targetId: null,
        action: "reply",
        mutationIntent: "none",
      },
    });
    assert.equal(first.ok, true);
    const rewrite = persistCloudInboundSemanticDecision({
      identity,
      messageId: "wamid.retry-accepted",
      semanticDecisionStatus: "accepted",
      ownershipLane: "post_confirm_pa",
      openaiSource: "openai",
      decision: {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: CIVIC_OLD_ID,
        action: "reply",
        mutationIntent: "none",
      },
    });
    assert.equal(rewrite.ok, false);
    assert.equal(rewrite.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    assert.equal(
      getCloudInboundSemanticDecision({ identity }).turnScope,
      "NEW_TRANSACTION"
    );
    assert.equal(getCloudInboundSemanticDecision({ identity }).targetId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
