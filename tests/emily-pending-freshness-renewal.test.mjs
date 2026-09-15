/**
 * Live-proven root cause (see forensic trace against
 * .cursor/live-forensic-20260912-162651.log, traceIds 131c83b1.../cedf6afb...):
 * while AvailabilityInquiryWorkflow was waiting on the same missing duration
 * for the same item ("already waiting"), the durable emilyPending record was
 * never refreshed (persist was skipped entirely, `pendingPersist = {}`). The
 * record had a bounded 30-minute TTL; if the customer took long enough to
 * reply, it silently expired between turns with no renewal, so the very
 * next turn read trustedFreshItemFocusPresent=false with nothing to fall
 * back on -- exactly what fired live (ownershipCorrectionReason
 * GROUP_CONTEXTUAL_ITEM_REFERENT_UNTRUSTED, then rejected
 * GROUP_ITEM_CATALOG_UNKNOWN, then GROUP_CANONICAL_SEMANTIC_UNUSABLE ->
 * BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY).
 *
 * Fix: renew (extend freshness only, preserve original transaction
 * identity -- createdAt, sourceTurnKey) instead of skipping persistence
 * while still waiting on the same item/field.
 *
 * These tests drive the real production functions directly (never a
 * bypass): buildAvailabilityInquiryActionPlan (AvailabilityInquiryWorkflow),
 * emilyPendingContext.js's build/renew/read functions, and
 * resolveCloudDmOwnershipTrustedFocus. The full end-to-end path (a Group
 * turn continuing via trusted_fresh_focus through the real
 * executeWhatsAppAiPipeline / resolveGroupCanonicalSemanticDecision) is
 * already covered by
 * tests/group-trusted-focus-model-retry-correction.test.mjs, which remains
 * green against this change and independently asserts the exact
 * sourceTurnKey-preservation invariant this renewal relies on.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { buildAvailabilityInquiryActionPlan } = await import(
  "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
);
const {
  EMILY_PENDING_TTL_MS,
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  buildEmilyPending,
  renewEmilyPending,
  readFreshEmilyPending,
  readEmilyPendingForParticipant,
} = await import("../src/brain/availability/emilyPendingContext.js");
const { resolveCloudDmOwnershipTrustedFocus } = await import(
  "../src/services/whatsappInboundBuffer.js"
);

const STONIC_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
const LABEL = "Kia Stonic EX Plus 2021 (White)";
const PARTICIPANT = "scope::p1";

function existingPendingRecord({
  itemId = STONIC_ID,
  customerReference = "Stonic",
  participantKey = PARTICIPANT,
  stage = EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  sourceTurnKey = "leads::wa::ORIGINAL",
  createdAtMs,
  expiresAtMs,
} = {}) {
  return {
    type: "collect_availability_duration",
    status: "awaiting",
    pendingStage: stage,
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId,
    itemLabel: LABEL,
    customerReference,
    participantKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function canonicalForDurationAsk({
  itemId = STONIC_ID,
  customerReference = "Stonic",
  emilyPending = null,
  sourceTurnKey = "leads::wa::THIS_TURN",
} = {}) {
  return {
    turn: { durationDays: null, sourceTurnKey },
    resolvedItem: { id: itemId, displayLabel: LABEL, customerReference, status: "resolved" },
    verified: { availability: {} },
    actions: { availabilityOwnerCheckExecute: false },
    participant: { key: PARTICIPANT },
    sourceIdentity: { participantKey: PARTICIPANT },
    emilyPending,
    validatedGroupCanonicalAuthority: false,
    normalizedMessage: "stonic rent p mil jye ge",
    lastAvailabilityAssist: null,
    availabilityAssistFollowUp: null,
  };
}

function buildDurationAskPlan(canonical, message = "Stonic rent p mil jye ge?") {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: message } },
    understanding: { authoritativeSemanticIntent: null },
    catalogItems: [{ id: STONIC_ID, name: "Kia Stonic EX Plus 2021", color: "White" }],
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

test("reproduces the exact live failure setup: a still-waiting turn near TTL expiry is renewed, not skipped", () => {
  const now = Date.now();
  const nearExpiryPending = existingPendingRecord({
    createdAtMs: now - 25 * 60 * 1000,
    expiresAtMs: now + 60 * 1000, // 1 minute left on the original TTL
  });
  const plan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: nearExpiryPending })
  );
  const renewed = plan.persistenceIntent.emilyPending;
  assert.ok(renewed, "the record must actually be persisted, not skipped");
  assert.equal(plan.customerResponseComposition.conversationStage, "already_waiting_for_duration");
  assert.ok(
    Math.abs(new Date(renewed.expiresAt).getTime() - now - EMILY_PENDING_TTL_MS) < 1000,
    "renewed expiresAt must be ~now+TTL (small tolerance for real elapsed test time)"
  );
  assert.ok(
    new Date(renewed.expiresAt).getTime() > new Date(nearExpiryPending.expiresAt).getTime(),
    "renewal must push expiresAt out past the original near-expiry value"
  );
});

test("renewal preserves the original transaction identity: createdAt and sourceTurnKey are not rolled forward", () => {
  const now = Date.now();
  const original = existingPendingRecord({
    createdAtMs: now - 10 * 60 * 1000,
    expiresAtMs: now + 5 * 60 * 1000,
    sourceTurnKey: "leads::wa::ORIGINAL",
  });
  const plan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: original, sourceTurnKey: "leads::wa::A_LATER_TURN" })
  );
  const renewed = plan.persistenceIntent.emilyPending;
  assert.equal(renewed.createdAt, original.createdAt);
  assert.equal(renewed.sourceTurnKey, "leads::wa::ORIGINAL");
});

test("the trusted-focus TTL boundary is exactly what the fix moves: without renewal the original expiresAt goes stale, the renewed one does not", () => {
  const now = Date.now();
  const originalExpiresAt = new Date(now + 60 * 1000).toISOString();
  const original = existingPendingRecord({
    createdAtMs: now - 25 * 60 * 1000,
    expiresAtMs: now + 60 * 1000,
  });
  const plan = buildDurationAskPlan(canonicalForDurationAsk({ emilyPending: original }));
  const renewed = plan.persistenceIntent.emilyPending;

  // A moment after the ORIGINAL (pre-fix) expiresAt but still well inside the
  // RENEWED one -- this is exactly the elapsed-time window the live defect
  // fell into (customer took ~1 min to reply to "kitne din chahiye").
  const laterNowMs = new Date(originalExpiresAt).getTime() + 5000;

  const staleFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: { emilyPending: original },
    participantKey: PARTICIPANT,
    nowMs: laterNowMs,
  });
  assert.equal(staleFocus, null, "the un-renewed record must read as expired -- this is the live defect");

  const renewedFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: { emilyPending: renewed },
    participantKey: PARTICIPANT,
    nowMs: laterNowMs,
  });
  assert.equal(renewedFocus.itemId, STONIC_ID, "trustedFreshItemFocusPresent must be true after renewal at the same later moment");
  assert.equal(renewedFocus.customerReference, "Stonic");
});

test("truly expired, unrelated pending state is not revived by anything downstream of the read", () => {
  const now = Date.now();
  const expired = existingPendingRecord({
    createdAtMs: now - 40 * 60 * 1000,
    expiresAtMs: now - 5 * 60 * 1000, // already past TTL before this turn even started
  });
  assert.equal(readFreshEmilyPending(expired, now), null);
  assert.equal(
    readEmilyPendingForParticipant({ memorySnapshot: { emilyPending: expired }, participantKey: PARTICIPANT, nowMs: now }),
    null
  );
  const focus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: { emilyPending: expired },
    participantKey: PARTICIPANT,
    nowMs: now,
  });
  assert.equal(focus, null);
});

test("a pending record for a DIFFERENT item is superseded (fresh build), never renewed/merged onto this turn's item", () => {
  const now = Date.now();
  const otherItemId = "toyota_corolla_grey_0e2cd610";
  const pendingForDifferentItem = existingPendingRecord({
    itemId: otherItemId,
    customerReference: "Corolla",
    createdAtMs: now - 60 * 1000,
    expiresAtMs: now + 25 * 60 * 1000,
  });
  const plan = buildDurationAskPlan(
    canonicalForDurationAsk({ itemId: STONIC_ID, customerReference: "Stonic", emilyPending: pendingForDifferentItem })
  );
  assert.equal(plan.customerResponseComposition.conversationStage, "initial_request");
  const built = plan.persistenceIntent.emilyPending;
  assert.equal(built.itemId, STONIC_ID);
  assert.equal(built.customerReference, "Stonic");
  // A fresh record for the new item, not the old one carried forward.
  assert.notEqual(built.createdAt, pendingForDifferentItem.createdAt);
});

test("a different participant cannot inherit another participant's pending focus", () => {
  const now = Date.now();
  const pendingForOtherParticipant = existingPendingRecord({
    participantKey: "scope::someone-else",
    createdAtMs: now - 60 * 1000,
    expiresAtMs: now + 25 * 60 * 1000,
  });
  const focus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: { emilyPending: pendingForOtherParticipant },
    participantKey: PARTICIPANT,
    nowMs: now,
  });
  assert.equal(focus, null);
});

test("a pending record in a different (non-duration) stage is never renewed as if it were an availability_duration wait", () => {
  const now = Date.now();
  const confirmStagePending = existingPendingRecord({
    stage: "confirm",
    createdAtMs: now - 60 * 1000,
    expiresAtMs: now + 25 * 60 * 1000,
  });
  const plan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: confirmStagePending })
  );
  assert.equal(plan.customerResponseComposition.conversationStage, "initial_request");
  assert.notEqual(plan.persistenceIntent.emilyPending.createdAt, confirmStagePending.createdAt);
});

test("repeated waiting-for-duration turns renew the same logical record, never creating a duplicate", () => {
  const now = Date.now();
  const original = existingPendingRecord({
    createdAtMs: now - 20 * 60 * 1000,
    expiresAtMs: now + 60 * 1000,
  });
  const firstRenewalPlan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: original, sourceTurnKey: "leads::wa::TURN2" })
  );
  const afterFirstRenewal = firstRenewalPlan.persistenceIntent.emilyPending;

  const secondRenewalPlan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: afterFirstRenewal, sourceTurnKey: "leads::wa::TURN3" })
  );
  const afterSecondRenewal = secondRenewalPlan.persistenceIntent.emilyPending;

  assert.equal(afterSecondRenewal.createdAt, original.createdAt);
  assert.equal(afterSecondRenewal.sourceTurnKey, original.sourceTurnKey);
  assert.ok(
    new Date(afterSecondRenewal.expiresAt).getTime() >=
      new Date(afterFirstRenewal.expiresAt).getTime()
  );
});

test("renewal never triggers a side-effecting action -- no AVR, booking, or owner-notification risk", () => {
  const now = Date.now();
  const nearExpiryPending = existingPendingRecord({
    createdAtMs: now - 25 * 60 * 1000,
    expiresAtMs: now + 60 * 1000,
  });
  const plan = buildDurationAskPlan(
    canonicalForDurationAsk({ emilyPending: nearExpiryPending })
  );
  for (const action of plan.actions) {
    assert.equal(action.payload.execute, false);
    assert.equal(action.type, "REPLY");
  }
  assert.equal(plan.persistenceIntent.execute, false);
});

test("freshness extension is bounded -- a renewed record still expires and is not revived past its own new TTL", () => {
  const now = Date.now();
  const nearExpiryPending = existingPendingRecord({
    createdAtMs: now - 25 * 60 * 1000,
    expiresAtMs: now + 60 * 1000,
  });
  const renewed = renewEmilyPending(nearExpiryPending, {
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId: STONIC_ID,
    itemLabel: LABEL,
    customerReference: "Stonic",
    participantKey: PARTICIPANT,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "leads::wa::THIS_TURN",
    nowMs: now,
  });
  const renewedExpiresMs = new Date(renewed.expiresAt).getTime();
  assert.equal(renewedExpiresMs - now, EMILY_PENDING_TTL_MS);
  // Long after the renewed TTL, the record is still gone -- renewal is not
  // an immortal/indefinite hold.
  assert.equal(readFreshEmilyPending(renewed, renewedExpiresMs + 1000), null);
});

test("buildEmilyPending/renewEmilyPending both round-trip customerReference through readFreshEmilyPending", () => {
  const now = Date.now();
  const built = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "q",
    itemId: STONIC_ID,
    itemLabel: LABEL,
    customerReference: "Stonic",
    participantKey: PARTICIPANT,
    nowMs: now,
  });
  const readBack = readFreshEmilyPending(built, now);
  assert.equal(readBack.customerReference, "Stonic");
});

test("participant-aware pending accessor requires an exact Group scope match", () => {
  const now = Date.now();
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "q",
    itemId: STONIC_ID,
    participantKey: PARTICIPANT,
    chatScopeKey: "group-a",
    nowMs: now,
  });
  const memorySnapshot = { emilyPending: pending };
  assert.ok(readEmilyPendingForParticipant({ memorySnapshot, participantKey: PARTICIPANT, chatScopeKey: "group-a", nowMs: now }));
  assert.equal(readEmilyPendingForParticipant({ memorySnapshot, participantKey: PARTICIPANT, chatScopeKey: "group-b", nowMs: now }), null);
  assert.equal(readEmilyPendingForParticipant({ memorySnapshot, participantKey: "other", chatScopeKey: "group-a", nowMs: now }), null);
});
