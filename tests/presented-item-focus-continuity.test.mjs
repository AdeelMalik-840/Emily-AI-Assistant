/**
 * Trusted presented-item focus (lastFreshItemFocus) continuity + isolation.
 * Exercises the real writer (applySessionMemoryFromActionPlan) and real
 * reader (peekEmilySessionState / readTrustedFreshItemFocus) against a
 * production-shaped action plan matching exactly what
 * AvailabilityInquiryWorkflow.js's temporal_clarification branch builds
 * (verified directly against the real workflow output in
 * tests/cloud-dm-stabilization-batch.test.mjs's "A" test).
 *
 * Isolation here is structural: lastFreshItemFocus lives inside a session
 * document keyed by sessionKey (businessId::chatKey::participant::participantKey),
 * so a different participant or a different Group/chat is a completely
 * different key/document -- never an in-record field to check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";

const ITEM_ID = "toyota_corolla";
const ITEM_LABEL = "Toyota Corolla";

function temporalClarificationPlan({ itemId = ITEM_ID, itemLabel = ITEM_LABEL, presentedItemIds } = {}) {
  return Object.freeze({
    planId: "plan-1",
    replyDraft: "Corolla kis date se chahiye?",
    customerResponseComposition: Object.freeze({
      lane: "availability",
      kind: "temporal_clarification",
      conversationStage: "awaiting_temporal_clarification",
      missingField: "start_date",
      verifiedAlternatives: Object.freeze([]),
    }),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: "Corolla kis date se chahiye?",
          field: "availability",
          itemId,
          itemLabel,
          source: "canonical_owner_check_ask_temporal_clarification",
          presentedItemIds: Object.freeze(presentedItemIds ?? [itemId]),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      rememberPresentedItemFocus: true,
      presentedItemId: itemId,
      presentedItemLabel: itemLabel,
      clearPendingAction: true,
      clearEmilyPending: true,
      execute: false,
    }),
  });
}

// ── Round-trip: a delivered temporal_clarification reply persists focus ──

test("a delivered temporal_clarification reply persists trusted presented-item focus", () => {
  const sessionKey = "biz::chatX::participant::customerA";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: temporalClarificationPlan(),
    sourceTurnId: "assistant:t1",
    outboundDelivered: true,
  });
  const state = peekEmilySessionState(sessionKey);
  assert.ok(state?.lastFreshItemFocus);
  assert.equal(state.lastFreshItemFocus.itemId, ITEM_ID);
  assert.equal(state.lastFreshItemFocus.itemLabel, ITEM_LABEL);
});

test("focus is NOT persisted when outboundDelivered is not true (reply never confirmed delivered)", () => {
  const sessionKey = "biz::chatX::participant::customerNotDelivered";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: temporalClarificationPlan(),
    sourceTurnId: "assistant:t1",
    outboundDelivered: false,
  });
  const state = peekEmilySessionState(sessionKey);
  assert.equal(state?.lastFreshItemFocus ?? null, null);
});

// ── Isolation: different participant, same Group -> rejected ─────────────

test("a different participant's session never sees another participant's persisted focus (same Group/chat)", () => {
  const sessionKeyA = "biz::groupG::participant::customerA";
  const sessionKeyB = "biz::groupG::participant::customerB";
  applySessionMemoryFromActionPlan({
    sessionKey: sessionKeyA,
    actionPlan: temporalClarificationPlan(),
    sourceTurnId: "assistant:t1",
    outboundDelivered: true,
  });
  const stateA = peekEmilySessionState(sessionKeyA);
  const stateB = peekEmilySessionState(sessionKeyB);
  assert.ok(stateA?.lastFreshItemFocus);
  assert.equal(stateB?.lastFreshItemFocus ?? null, null, "participant B must never inherit participant A's focus");
});

// ── Isolation: same participant, different Group -> rejected ─────────────

test("the same participant's session in a different Group never sees the other Group's persisted focus", () => {
  const sessionKeyGroupA = "biz::groupA::participant::customerA";
  const sessionKeyGroupB = "biz::groupB::participant::customerA";
  applySessionMemoryFromActionPlan({
    sessionKey: sessionKeyGroupA,
    actionPlan: temporalClarificationPlan(),
    sourceTurnId: "assistant:t1",
    outboundDelivered: true,
  });
  const stateGroupA = peekEmilySessionState(sessionKeyGroupA);
  const stateGroupB = peekEmilySessionState(sessionKeyGroupB);
  assert.ok(stateGroupA?.lastFreshItemFocus);
  assert.equal(stateGroupB?.lastFreshItemFocus ?? null, null, "Group B must never inherit Group A's focus for the same participant");
});

// ── Expiry ─────────────────────────────────────────────────────────────

test("an expired persisted focus is rejected by the reader even though the record still exists", async () => {
  const { readTrustedFreshItemFocus } = await import("../src/services/executors/sessionMemoryExecutor.js");
  const sessionKey = "biz::chatX::participant::customerExpiry";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: temporalClarificationPlan(),
    sourceTurnId: "assistant:t1",
    outboundDelivered: true,
  });
  const state = peekEmilySessionState(sessionKey);
  assert.ok(state?.lastFreshItemFocus);
  // Read it back far beyond the TTL.
  const stillFreshAt1Ms = readTrustedFreshItemFocus(state, Date.now() + 1000);
  assert.ok(stillFreshAt1Ms, "sanity: fresh right after write");
  const afterTtl = readTrustedFreshItemFocus(state, Date.now() + 20 * 60 * 1000);
  assert.equal(afterTtl, null, "an expired focus must be rejected, never returned as trusted");
});

// ── Supersession: an explicit new item overrides stale focus ─────────────

test("rememberResolvedItem without rememberPresentedItemFocus clears a stale prior focus (explicit new item supersedes it)", () => {
  const sessionKey = "biz::chatX::participant::customerSupersede";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: temporalClarificationPlan({ itemId: "toyota_corolla", itemLabel: "Toyota Corolla" }),
    sourceTurnId: "assistant:t1",
    outboundDelivered: true,
  });
  assert.equal(peekEmilySessionState(sessionKey)?.lastFreshItemFocus?.itemId, "toyota_corolla");

  // Customer now explicitly names a different item; the resolved-item action
  // plan (no rememberPresentedItemFocus) clears the stale prior focus per
  // sessionMemoryExecutor.js's own existing contract.
  const newItemPlan = Object.freeze({
    planId: "plan-2",
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: "kia_stonic",
    }),
  });
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: newItemPlan,
    sourceTurnId: "assistant:t2",
    outboundDelivered: true,
    authoritativeItem: { id: "kia_stonic", displayLabel: "Kia Stonic" },
  });
  const state = peekEmilySessionState(sessionKey);
  assert.equal(state?.lastFreshItemFocus ?? null, null, "the stale Corolla focus must not survive an explicit new-item turn");
  assert.equal(state?.lastResolvedItemId, "kia_stonic");
});

// ── Alternatives-list behavior is unaffected by the fix ──────────────────

test("availability_alternatives presentedItemIds filtering (verified-alternatives gating) is unaffected by the temporal_clarification fix", async () => {
  const { applyAvailabilityCustomerResponse } = await import("../src/brain/workflows/AvailabilityInquiryWorkflow.js");
  const alternativesPlan = Object.freeze({
    customerResponseComposition: Object.freeze({
      lane: "availability",
      kind: "availability_alternatives",
      verifiedAlternatives: Object.freeze([{ itemId: "kia_stonic", itemLabel: "Kia Stonic" }]),
    }),
    actions: Object.freeze([
      Object.freeze({ type: "REPLY", payload: Object.freeze({ presentedItemIds: Object.freeze([]) }) }),
    ]),
    persistenceIntent: Object.freeze({}),
  });
  const result = applyAvailabilityCustomerResponse(alternativesPlan, {
    reply: "Stonic available hai.",
    presentedItemIds: ["kia_stonic"],
  });
  const replyAction = result.actions.find((a) => a.type === "REPLY");
  assert.deepEqual(replyAction.payload.presentedItemIds, ["kia_stonic"]);
  assert.equal(result.persistenceIntent.rememberPresentedItemFocus, true);
  assert.equal(result.persistenceIntent.presentedItemId, "kia_stonic");

  // An untrusted id (not in verifiedAlternatives) must still be filtered out.
  const untrustedResult = applyAvailabilityCustomerResponse(alternativesPlan, {
    reply: "Stonic available hai.",
    presentedItemIds: ["untrusted_id"],
  });
  const untrustedReplyAction = untrustedResult.actions.find((a) => a.type === "REPLY");
  assert.deepEqual(untrustedReplyAction.payload.presentedItemIds, []);
});
