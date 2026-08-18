import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROD_CIVIC_BOOKING_ID,
  PROD_CIVIC_SAME_ITEM_NEW_DURATION,
  PROD_STONIC_BOOKING_ID,
  productionRichCivicStonicFacts,
  productionRichFactsWithPendingCivic,
  productionRichTwoCivicFacts,
  productionRichTwoCivicFactsReversed,
} from "./helpers/cloudDmProductionRichOwnershipFixture.mjs";

const runReal =
  process.env.RUN_REAL_POST_CONFIRM_SEMANTIC_OWNERSHIP === "true" &&
  Boolean(process.env.OPENAI_API_KEY);

const { resolveCloudDmCanonicalOwnership } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
async function decideOwnership(message, facts, conversationHistory = null) {
  const result = await resolveCloudDmCanonicalOwnership({
    facts,
    userMessage: message,
    conversationHistory,
    timeoutMs: 20000,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "openai");
  assert.equal(result.ownershipCompletionCount, 1);
  return result.decision;
}

test(
  "real OpenAI: production-rich Civic same-item/new-duration is NEW_TRANSACTION",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      PROD_CIVIC_SAME_ITEM_NEW_DURATION,
      productionRichCivicStonicFacts()
    );
    assert.equal(result.turnScope, "NEW_TRANSACTION");
    assert.equal(result.targetId, null);
    assert.equal(result.mutationIntent, "none");
  }
);

test(
  "real OpenAI: different fresh item with old Civic/Stonic history is NEW_TRANSACTION",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "Toyota Corolla 3 din k liye chahiye",
      productionRichCivicStonicFacts()
    );
    assert.equal(result.turnScope, "NEW_TRANSACTION");
    assert.equal(result.targetId, null);
  }
);

test(
  "real OpenAI: pending Civic factual stays on exact AVR",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "per day kitna hai?",
      productionRichFactsWithPendingCivic(),
      "Emily: Honda Civic 2026 Oriel (White) 3 din, 8000/day waiting confirm. Confirm karen?\nUser: per day kitna hai?"
    );
    assert.equal(result.turnScope, "PENDING_AVAILABILITY_REFERENCE");
    assert.equal(result.targetId, "avr_pending_civic_waiting_confirm");
  }
);

test(
  "real OpenAI: pending Civic confirm stays on exact AVR",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "haan kar do",
      productionRichFactsWithPendingCivic()
    );
    assert.equal(result.turnScope, "PENDING_AVAILABILITY_REFERENCE");
    assert.equal(result.targetId, "avr_pending_civic_waiting_confirm");
    assert.equal(result.action, "confirm_pending_availability");
  }
);

test(
  "real OpenAI: pending Civic decline stays on exact AVR",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "nahi, offer cancel kar do",
      productionRichFactsWithPendingCivic(),
      "Emily: Honda Civic 2026 Oriel (White) 3 din waiting confirm. Confirm karen?\nUser: nahi, offer cancel kar do"
    );
    assert.equal(result.turnScope, "PENDING_AVAILABILITY_REFERENCE");
    assert.equal(result.targetId, "avr_pending_civic_waiting_confirm");
    assert.equal(result.action, "decline_pending_availability");
  }
);

test(
  "real OpenAI: old Stonic fact selects exact booking",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "Meri Stonic booking ka total rent kitna hai?",
      productionRichCivicStonicFacts()
    );
    assert.equal(result.turnScope, "OLD_BOOKING_REFERENCE");
    assert.equal(result.targetId, PROD_STONIC_BOOKING_ID);
  }
);

test(
  "real OpenAI: old Stonic mutation selects exact booking",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "Meri Stonic booking cancel kar do",
      productionRichCivicStonicFacts()
    );
    assert.equal(result.turnScope, "OLD_BOOKING_REFERENCE");
    assert.equal(result.targetId, PROD_STONIC_BOOKING_ID);
    assert.equal(result.mutationIntent, "cancel_booking");
  }
);

test("real OpenAI: Hello is SOCIAL_GENERAL", { skip: !runReal }, async () => {
  const result = await decideOwnership(
    "Hello",
    productionRichCivicStonicFacts()
  );
  assert.equal(result.turnScope, "SOCIAL_GENERAL");
  assert.equal(result.targetId, null);
});

test(
  "real OpenAI: ambiguous same-item does not guess a mutation owner",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "Civic booking extend kar do",
      productionRichTwoCivicFacts()
    );
    assert.equal(result.turnScope, "UNCLEAR");
    assert.equal(result.targetId, null);
    assert.equal(result.mutationIntent, "none");
  }
);

test(
  "real OpenAI: reversed ambiguous same-item is also UNCLEAR",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      "Civic booking extend kar do",
      productionRichTwoCivicFactsReversed()
    );
    assert.equal(result.turnScope, "UNCLEAR");
    assert.equal(result.targetId, null);
    assert.equal(result.mutationIntent, "none");
  }
);

test(
  "real OpenAI: explicit Civic booking id selects that exact historical booking",
  { skip: !runReal },
  async () => {
    const result = await decideOwnership(
      `Meri booking ${PROD_CIVIC_BOOKING_ID} ka status kya hai?`,
      productionRichTwoCivicFacts()
    );
    assert.equal(result.turnScope, "OLD_BOOKING_REFERENCE");
    assert.equal(result.targetId, PROD_CIVIC_BOOKING_ID);
    assert.equal(result.mutationIntent, "none");
  }
);

test(
  "real OpenAI: accepted ownership is not re-decided on PA retry",
  { skip: !runReal },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "emily-real-own-resume-"));
    __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
    __clearInboundTurnLedgerForTests();
    try {
      const identity = buildCloudInboundLifecycleIdentity({
        businessId: "biz-real-resume",
        customerPhone: "923001234567",
        messageId: "wamid.real-semantic-resume",
      });
      claimCloudInboundTurn({
        businessId: "biz-real-resume",
        customerPhone: "923001234567",
        messageId: "wamid.real-semantic-resume",
      });
      const first = await resolveCloudDmCanonicalOwnership({
        facts: productionRichCivicStonicFacts(),
        userMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
        timeoutMs: 20000,
      });
      assert.equal(first.ok, true);
      assert.equal(first.ownershipCompletionCount, 1);
      persistCloudInboundSemanticDecision({
        identity,
        messageId: "wamid.real-semantic-resume",
        semanticDecisionStatus: "released",
        ownershipLane: "normal_routing",
        openaiSource: "openai",
        decision: first.decision,
      });
      const snapshot = getCloudInboundSemanticDecision({ identity });
      assert.equal(snapshot.turnScope, "NEW_TRANSACTION");
      assert.equal(snapshot.targetId, null);
      const rewrite = persistCloudInboundSemanticDecision({
        identity,
        messageId: "wamid.real-semantic-resume",
        semanticDecisionStatus: "accepted",
        ownershipLane: "post_confirm_pa",
        openaiSource: "openai",
        decision: {
          turnScope: "OLD_BOOKING_REFERENCE",
          targetId: PROD_CIVIC_BOOKING_ID,
          action: "reply",
          mutationIntent: "none",
        },
      });
      assert.equal(rewrite.ok, false);
      assert.equal(
        getCloudInboundSemanticDecision({ identity }).turnScope,
        "NEW_TRANSACTION"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
