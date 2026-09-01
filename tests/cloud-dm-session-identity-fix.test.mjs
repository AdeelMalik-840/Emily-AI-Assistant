/**
 * Root-cause fix: Cloud DM (and Playwright DM) session-memory reads used
 * resolveGroupParticipantContextKey(), which ran the raw session identity
 * through normalizeText() -- a MESSAGE-TEXT classifier (lowercase + collapse
 * repeated characters) -- before deriving the read key. The session-memory
 * WRITER (patchEmilySessionState, via applySessionMemoryFromActionPlan) uses
 * the raw, case-preserving session key untouched. For any real production
 * identity containing uppercase characters (every Firebase UID does, e.g.
 * "afWvEVJnssbbp6Jt2GIu23uCrTF2"), the writer and reader therefore computed
 * DIFFERENT map keys -- the write silently succeeded, but the very next
 * turn's read always missed it.
 *
 * This is the proven root cause of the live "Civic k rent ka idea?" ->
 * "yeh available hai ya ni?" failure (production traceIds
 * 56801990-fc04-426a-b14c-e3b1d2356c67 / 4a064f15-f8ec-44eb-9d50-9dab628a99a9),
 * and -- because resolveBusinessTurnContext's memorySnapshot is populated
 * through the exact same read path -- it is the SAME underlying contract
 * defect behind the earlier temporal-clarification duration-continuation
 * fix (pendingTemporalClarification), not a separate cause. All tests here
 * use a real, mixed-case, production-shaped session identity and the real
 * writer -> real production read path -> real ownership hydration chain --
 * no lastFreshItemFocus is ever injected directly.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  parseCloudDmOwnershipDecision,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import {
  loadBrainV2SessionMemorySnapshot,
  resolveCloudDmOwnershipTrustedFocus,
} from "../src/services/whatsappInboundBuffer.js";

const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const CIVIC_LABEL = "Honda Civic 2026 Oriel (White)";
const STONIC_ID = "kia_stonic_ex_plus_2021_white";
const STONIC_LABEL = "Kia Stonic EX Plus 2021 (White)";
const COROLLA_ID = "toyota_corolla_metallic_grey";
const COROLLA_LABEL = "Toyota Corolla (Metallic Grey)";
const CATALOG = [
  // Real pricing so a pricing_inquiry turn (used here only as a vehicle for
  // item-focus/session-identity persistence) resolves normally instead of
  // triggering the known-item-missing-price composer override added later.
  { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: { daily: 8000, monthly: 165000 } },
  { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL, pricing: { daily: 6000 } },
  { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL, pricing: { daily: 5000 } },
];
const NOW_MS = Date.parse("2026-08-29T20:31:00.000Z");

// Real production identity shape: mixed-case Firebase UID + numeric wa_id.
const OWNER_USER_ID = "afWvEVJnssbbp6Jt2GIu23uCrTF2";
const CUSTOMER_PHONE = "905443829990";

function realSessionKey(testSuffix) {
  return `${OWNER_USER_ID}${testSuffix}::${CUSTOMER_PHONE}`;
}

function span(text, surface) {
  const start = text.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}
function baseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    itemScope: "specific",
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    action: "reply",
    mutationIntent: "none",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

const civicBookingNow = {
  id: "booking-civic-active",
  itemId: CIVIC_ID,
  status: "confirmed",
  startAt: new Date(NOW_MS - 86400000).toISOString(),
  endAt: new Date(NOW_MS + 86400000).toISOString(),
};
const stonicBookingNow = {
  id: "booking-stonic-active",
  itemId: STONIC_ID,
  status: "confirmed",
  startAt: new Date(NOW_MS - 86400000).toISOString(),
  endAt: new Date(NOW_MS + 86400000).toISOString(),
};
function bookingsForItem(itemId) {
  if (itemId === CIVIC_ID) return [civicBookingNow];
  if (itemId === STONIC_ID) return [stonicBookingNow];
  return [];
}

/**
 * Real production read: exactly what whatsappInboundBuffer.js does before
 * the next turn's ownership call -- resolves the session key through
 * resolveGroupParticipantContextKey()/chatSessionKey() (NOT a direct
 * peekEmilySessionState by the raw key).
 */
async function realProductionMemorySnapshot(sessionKey) {
  return loadBrainV2SessionMemorySnapshot({
    businessId: OWNER_USER_ID,
    ownerUserId: OWNER_USER_ID,
    sessionKey,
    participantKey: CUSTOMER_PHONE,
    playwrightChatKey: null,
    isGroupInbound: false,
  });
}

async function resolveCanonical(message, canonicalSemanticDecision, memorySnapshot, authoritativeItem = null) {
  return resolveBusinessTurnContext({
    traceId: "t-session-identity",
    businessId: OWNER_USER_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async (_bid, itemId) => bookingsForItem(itemId),
    turnContextInput: {
      chatType: "dm",
      chatId: `${OWNER_USER_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      participantPhone: CUSTOMER_PHONE,
      sourceMessageId: "m2",
      guaranteeKey: "m2",
      // In real production this is populated by buildTurnContextInput.js from
      // the already-hydrated canonical item referent (current_turn span or
      // trusted_fresh_focus trustedItemId) before resolveBusinessTurnContext
      // runs -- reproduced explicitly here since this test calls
      // resolveBusinessTurnContext directly.
      authoritativeItem,
    },
    turnContext: {
      sessionId: "s1",
      businessId: OWNER_USER_ID,
      chatKey: `${OWNER_USER_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      schemaVersion: 1,
      memorySnapshot: memorySnapshot ?? {},
      canonicalSemanticDecision,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

/**
 * Real turn 1: Civic pricing, real pipeline + real post-send session write,
 * using the real mixed-case production session key.
 */
async function runCivicPricingTurn1(sessionKey) {
  const message1 = "Civic k rent ka idea?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message1, "Civic")] })),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-56801990-fc04-426a-b14c-e3b1d2356c67",
    businessId: OWNER_USER_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message: message1,
    messageId: "wamid.turn1",
    catalogItems: CATALOG,
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Honda Civic 2026 Oriel (White) ka rent 8,000 PKR per day aur 165,000 PKR per month hai.",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        customerInputRequested: false, requestedInput: null, availabilityCheckStarted: false,
      }) } }],
    }),
  });
  assert.equal(result1.handled, true);
  assert.equal(result1.messageMeta?.actionPlan?.persistenceIntent?.rememberPresentedItemFocus, true);
  assert.equal(result1.messageMeta?.actionPlan?.persistenceIntent?.presentedItemId, CIVIC_ID);
  // Real write: exactly the whatsappInboundBuffer.js call site, real session key.
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: result1.messageMeta.actionPlan,
    sourceTurnId: "assistant:wamid.turn1",
    outboundDelivered: true,
  });
  return result1;
}

// ---------------------------------------------------------------------------
// TEST A — real pricing -> availability continuation through the real
// production read path (the exact failing production shape).
// ---------------------------------------------------------------------------

test("A. real Civic pricing -> real production read -> contextual availability finds the active booking, no ITEM_REFERENT_SURFACE_MISMATCH, no technical recovery", async () => {
  const sessionKey = realSessionKey("-A");
  await runCivicPricingTurn1(sessionKey);

  // The exact read path production uses -- NOT a direct peek by raw key.
  const snapshot = await realProductionMemorySnapshot(sessionKey);
  assert.ok(snapshot?.lastFreshItemFocus, "real production read path must see the Civic focus written after turn 1");
  assert.equal(snapshot.lastFreshItemFocus.itemId, CIVIC_ID);

  // lastFreshItemFocus.expiresAt is stamped from the real wall clock
  // (Date.now()) inside applySessionMemoryFromActionPlan, so freshness here
  // must be checked against the real clock too, not the fixed NOW_MS used
  // for deterministic booking-date math elsewhere in this file.
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: snapshot,
    participantKey: CUSTOMER_PHONE,
  });
  assert.ok(trustedFocus, "resolveCloudDmOwnershipTrustedFocus must return the Civic focus via the real read path");
  assert.equal(trustedFocus.itemId, CIVIC_ID);

  const message2 = "yeh available hai ya ni?";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      semanticIntent: "availability_inquiry",
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
    })),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus, onStructuralRejection: (d) => { rejection = d; } }
  );
  assert.equal(rejection, null, "no ITEM_REFERENT_SURFACE_MISMATCH when ownership legitimately uses trusted_fresh_focus");
  assert.equal(parsed2.itemReferents[0].trustedItemId, CIVIC_ID);

  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical2.verified.availability.status, "unavailable");
  assert.equal(canonical2.verified.availability.hasActiveBlockingBookingNow, true);

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: OWNER_USER_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.itemId, CIVIC_ID);
  assert.equal(reply2.payload.source, "canonical_owner_check_active_blocking_now");
  assert.notEqual(reply2.payload.text, "Abhi ye detail confirm nahi hai.");
  assert.equal((plan2.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
});

// ---------------------------------------------------------------------------
// TEST B — pronoun referring to a different fact about the same item must
// still resolve the item via the real read path.
// ---------------------------------------------------------------------------

test("B. real Civic pricing -> real production read -> 'iska color kya hai?' still resolves Civic via trusted context", async () => {
  const sessionKey = realSessionKey("-B");
  await runCivicPricingTurn1(sessionKey);
  const snapshot = await realProductionMemorySnapshot(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: CUSTOMER_PHONE });
  assert.equal(trustedFocus?.itemId, CIVIC_ID);

  const message2 = "iska color kya hai?";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      semanticIntent: "details_inquiry",
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
    })),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus, onStructuralRejection: (d) => { rejection = d; } }
  );
  assert.equal(rejection, null);
  assert.equal(parsed2.itemReferents[0].trustedItemId, CIVIC_ID);

  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID, "context must be retained for a non-availability fact about the same trusted item");
});

// ---------------------------------------------------------------------------
// TEST C — a fresh, explicitly named item always overrides stale context.
// ---------------------------------------------------------------------------

test("C. fresh explicit 'Corolla available hai?' overrides Civic context, no leakage", async () => {
  const sessionKey = realSessionKey("-C");
  await runCivicPricingTurn1(sessionKey);
  const snapshot = await realProductionMemorySnapshot(sessionKey);

  const message2 = "Corolla available hai?";
  const decision2 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message2, "Corolla")] })),
      { customerMessage: message2, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical2 = await resolveCanonical(message2, decision2, snapshot, { id: COROLLA_ID, name: COROLLA_LABEL });
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID, "fresh explicit Corolla must win over stale Civic focus");
  assert.notEqual(canonical2.resolvedItem?.id, CIVIC_ID);
});

// ---------------------------------------------------------------------------
// TEST D — an expired focus must not resolve a later itemless message.
// ---------------------------------------------------------------------------

test("D. expired Civic focus does not resolve a later unrelated 'yeh'", async () => {
  const sessionKey = realSessionKey("-D");
  await runCivicPricingTurn1(sessionKey);
  const snapshot = await realProductionMemorySnapshot(sessionKey);
  assert.ok(snapshot.lastFreshItemFocus);

  // 20 minutes later (real wall clock) -- beyond the 15-minute TTL.
  const expiredTrustedFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: snapshot,
    participantKey: CUSTOMER_PHONE,
    nowMs: Date.now() + 20 * 60 * 1000,
  });
  assert.equal(expiredTrustedFocus, null, "expired focus must not be returned as trusted");
});

// ---------------------------------------------------------------------------
// TEST E — context moves to a newly presented item across a real multi-turn
// conversation (Civic pricing -> contextual availability -> explicit Stonic
// -> contextual follow-up on Stonic).
// ---------------------------------------------------------------------------

test("E. context moves naturally to the newly presented item across a real multi-turn conversation", async () => {
  const sessionKey = realSessionKey("-E");
  await runCivicPricingTurn1(sessionKey);
  let snapshot = await realProductionMemorySnapshot(sessionKey);
  let trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: CUSTOMER_PHONE });
  assert.equal(trustedFocus?.itemId, CIVIC_ID);

  // Turn 2: contextual availability on Civic (via the real workflow, not a
  // manually constructed reply), then real session-memory write again.
  const message2 = "yeh available hai ya ni?";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      semanticIntent: "availability_inquiry",
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
    })),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus }
  );
  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: CIVIC_ID, name: CIVIC_LABEL });
  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: OWNER_USER_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan2,
    sourceTurnId: "assistant:wamid.turn2",
    outboundDelivered: true,
  });

  // Turn 3: explicit Stonic -- fresh item must replace Civic in memory.
  snapshot = await realProductionMemorySnapshot(sessionKey);
  const message3 = "Stonic?";
  const decision3 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message3, "Stonic")] })),
      { customerMessage: message3, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical3 = await resolveCanonical(message3, decision3, snapshot, { id: STONIC_ID, name: STONIC_LABEL });
  assert.equal(canonical3.resolvedItem?.id, STONIC_ID);
  const plan3 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t3", businessId: OWNER_USER_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message3, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem3", admissionReason: "test" },
    understanding: { resolvedItemId: STONIC_ID, resolvedItemLabel: STONIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical3.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical3 },
  });
  assert.equal(plan3.persistenceIntent.rememberPresentedItemFocus, true);
  assert.equal(plan3.persistenceIntent.presentedItemId, STONIC_ID);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan3,
    sourceTurnId: "assistant:wamid.turn3",
    outboundDelivered: true,
  });

  // Turn 4: itemless contextual follow-up must now bind to Stonic, not Civic.
  snapshot = await realProductionMemorySnapshot(sessionKey);
  assert.equal(snapshot.lastFreshItemFocus?.itemId, STONIC_ID, "context must have moved to the newly presented Stonic");
  const trustedFocus4 = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: CUSTOMER_PHONE });
  assert.equal(trustedFocus4?.itemId, STONIC_ID);
});

// ---------------------------------------------------------------------------
// TEST F — regression proving the validator still correctly rejects a
// fabricated current_turn referent for an itemless message, even when a
// legitimate trusted focus is available. The fix makes trusted focus
// reachable; it must never let a fabricated span slip through instead.
// ---------------------------------------------------------------------------

test("F. fabricated current_turn referent for an itemless message is still rejected even when legitimate trusted focus is available", async () => {
  const sessionKey = realSessionKey("-F");
  await runCivicPricingTurn1(sessionKey);
  const snapshot = await realProductionMemorySnapshot(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: CUSTOMER_PHONE });
  assert.equal(trustedFocus?.itemId, CIVIC_ID);

  // Exact shape of the proven production failure: GPT believes the item is
  // Civic and emits source=current_turn naming it, even though "Civic" does
  // not appear anywhere in this message -- any offset then fails the
  // slice(start,end) === surfaceText integrity check.
  const message2 = "yeh available hai ya ni?";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      semanticIntent: "availability_inquiry",
      itemReferenceMode: "CURRENT_TURN",
      itemReferents: [{ source: "current_turn", surfaceText: "Civic", start: 0, end: 5, trustedItemId: null, sourceTurnId: null }],
    })),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus, onStructuralRejection: (d) => { rejection = d; } }
  );
  assert.equal(parsed2, null, "a fabricated current_turn span must still fail closed");
  assert.ok(rejection, "structural rejection must fire");
  assert.equal(rejection.rejectionCode ?? rejection.code ?? rejection, "ITEM_REFERENT_SURFACE_MISMATCH");
});
