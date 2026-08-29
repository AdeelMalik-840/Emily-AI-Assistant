/**
 * Root-cause fix: Emily treated an INVALID supplied date (e.g. "31 February")
 * identically to a MISSING date. Both collapsed into the same undifferentiated
 * dateWindowConfidence="temporal_unresolved" state with the same generic
 * "give me a date" wording objective.
 *
 * Traced precisely (see final report): the loss point is
 * resolveItemBookingAwareAvailability.js's resolveAvailabilityOverlapWindow(),
 * which returned the identical TEMPORAL_UNRESOLVED_WINDOW marker for three
 * distinct customer situations:
 *  1. startDateKind="unresolved" (the AI temporal owner could not map the
 *     customer's reference to a specific day+month -- a genuinely AMBIGUOUS
 *     reference, e.g. "next Friday").
 *  2. a structurally valid explicit_date (day 1-31, month 1-12) that fails
 *     REAL calendar validity (resolveExplicitCalendarDateWindow's
 *     isValidCalendarDate check) -- e.g. 31 February, 31 April. This is an
 *     INVALID date, not an ambiguous one: the customer gave specific digits
 *     that simply don't form a real date.
 *  3. a relative date (kal/parson) whose window computation fails (rare
 *     edge case) -- classified with invalid_date for the same reason.
 * A fourth, distinct case -- NO_DATE_SUPPLIED (startDateKind="none", the
 * customer referenced no date at all) -- was traced and found to NEVER reach
 * this composer at all: it correctly falls through to the pre-existing,
 * unrelated, already-working duration_default_now window (unchanged,
 * verified by test F below and by the existing "G. genuinely no date +
 * duration -> duration_default_now unchanged" test in
 * availability-temporal-unresolved-safety.test.mjs). It is not a
 * proven live defect and was not given a new trigger here.
 *
 * FIX: resolveAvailabilityOverlapWindow now returns a distinct
 * unresolvedReason ("invalid_date" | "ambiguous_date") alongside the
 * unchanged dateWindowConfidence="temporal_unresolved" safety-gate value
 * (every existing consumer of that gate is untouched). The reason flows
 * through resolveBusinessTurnContext -> canonical.verified.availability
 * (already a direct pass-through, no new field stripped) ->
 * trustedFactsForCloudCompose (new dateIssueReason trusted fact) ->
 * composeCloudCanonicalCustomerReply's temporal_clarification objective,
 * which now gives the model two distinct semantic objectives instead of one.
 * OpenAI still owns the actual wording; only the deterministic input differs.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { parseCloudDmOwnershipDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveCloudDmOwnershipTrustedFocus } from "../src/services/whatsappInboundBuffer.js";

const CIVIC_ID = "honda_civic";
const CIVIC_LABEL = "Honda Civic";
const CATALOG = [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: { daily: 8000 } }];
// Real wall-clock "now" -- tests 6-9 write real session state via
// applySessionMemoryFromActionPlan (which stamps createdAt/expiresAt from
// the real clock), then read it back through resolveBusinessTurnContext
// with this same nowMs for TTL freshness checks. A fixed, unrelated
// timestamp here would desync from the real clock and falsely appear
// expired/not-yet-valid. Real "now" is safely before September, so the
// explicit-calendar-date year-rollover logic still resolves Sep 3 to the
// current year as intended.
const NOW_MS = Date.now();
const SEP3_START_ISO = "2026-09-02T19:00:00.000Z";
const SEP5_END_ISO = "2026-09-04T19:00:00.000Z";

function span(text, surface) {
  const start = text.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}
function baseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
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

async function resolveCanonical(message, canonicalSemanticDecision, memorySnapshot = {}, authoritativeItem = { id: CIVIC_ID, name: CIVIC_LABEL }) {
  return resolveBusinessTurnContext({
    traceId: "t-invalid-vs-missing",
    businessId: "biz",
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: {
      chatType: "dm", chatId: "biz::923001234567", participantKey: "923001234567", participantPhone: "923001234567",
      sourceMessageId: "m1", guaranteeKey: "m1", authoritativeItem,
    },
    turnContext: {
      sessionId: "s1", businessId: "biz", chatKey: "biz::923001234567", participantKey: "923001234567",
      schemaVersion: 1, memorySnapshot, canonicalSemanticDecision,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

function planFor(message, canonical, resolvedItemId = CIVIC_ID, resolvedItemLabel = CIVIC_LABEL) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: "biz", channelId: "whatsapp_cloud", chatKey: "dm", participantKey: "923001234567", text: message, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding: { resolvedItemId, resolvedItemLabel, itemSource: "explicit", askedField: "availability", durationDays: canonical.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

// ---------------------------------------------------------------------------
// TEST 1 — no date supplied: unchanged, pre-existing, correct behavior
// (never reaches temporal_clarification at all).
// ---------------------------------------------------------------------------

test("1. missing date: genuinely no date reference falls through to the unchanged duration_default_now window, not temporal_clarification", async () => {
  const message = "Civic 2 din ke liye available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message, "Civic")], temporalRequest: { startDateKind: "none", startDate: null } })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision);
  assert.notEqual(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical.verified.availability.temporalUnresolvedReason ?? null, null);
  const plan = planFor(message, canonical);
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.notEqual(reply?.payload?.source, "canonical_owner_check_ask_temporal_clarification");
});

// ---------------------------------------------------------------------------
// TEST 2 — invalid date supplied (31 February): distinctly reasoned,
// distinct composer objective from ambiguous.
// ---------------------------------------------------------------------------

test("2. invalid date (31 February): temporal_unresolved with reason=invalid_date, distinct composer objective, no booking created", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } } })),
      { customerMessage: message, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }] }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision, {}, { id: "corolla", name: "Corolla" });
  assert.equal(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical.verified.availability.temporalUnresolvedReason, "invalid_date");
  assert.equal(canonical.turn?.durationDays, 2, "duration must be retained even though the date is invalid");

  const plan = planFor(message, canonical, "corolla", "Corolla");
  const ownerCheck = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(ownerCheck, undefined, "no owner-check/AVR may be created for an invalid date");
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.equal(reply.payload.source, "canonical_owner_check_ask_temporal_clarification");

  // Composer objective must be the invalid-date-specific one, not the
  // generic ambiguous "could not be understood" wording.
  let capturedSystem = "";
  let capturedUser = "";
  const result = await runBrainV2LivePipeline({
    traceId: "t-invalid-2", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message, messageId: "wamid.invalid-2",
    catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }],
    canonicalSemanticDecision: decision,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      capturedUser = String(args.messages?.[1]?.content ?? "");
      return { choices: [{ message: { content: JSON.stringify({
        customerReply: "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
      }) } }] };
    },
  });
  assert.equal(result.handled, true);
  assert.match(capturedUser, /"dateIssueReason":"invalid_date"/);
  assert.match(capturedSystem, /not (a )?real calendar date/i);
  assert.match(capturedSystem, /not valid/i);
  assert.doesNotMatch(capturedSystem, /could not be understood/i);
});

// ---------------------------------------------------------------------------
// TEST 3 — another invalid date (31 April): same treatment, not hardcoded
// to February.
// ---------------------------------------------------------------------------

test("3. another invalid date (31 April): same invalid_date reason, proving no hardcoded February handling", async () => {
  const message = "Civic 31 April se available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message, "Civic")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 4 } } })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision);
  assert.equal(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical.verified.availability.temporalUnresolvedReason, "invalid_date");
});

// ---------------------------------------------------------------------------
// TEST 4 — ambiguous/unresolvable date: distinct reason and objective from
// invalid.
// ---------------------------------------------------------------------------

test("4. ambiguous date ('next Friday' style, startDateKind=unresolved): reason=ambiguous_date, distinct composer objective", async () => {
  const message = "Civic agle Friday available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message, "Civic")], temporalRequest: { startDateKind: "unresolved", startDate: null } })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision);
  assert.equal(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical.verified.availability.temporalUnresolvedReason, "ambiguous_date");

  let capturedSystem = "";
  let capturedUser = "";
  const result = await runBrainV2LivePipeline({
    traceId: "t-ambiguous-4", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message, messageId: "wamid.ambiguous-4",
    catalogItems: CATALOG, canonicalSemanticDecision: decision,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      capturedUser = String(args.messages?.[1]?.content ?? "");
      return { choices: [{ message: { content: JSON.stringify({
        customerReply: "Civic kis date se chahiye?",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
      }) } }] };
    },
  });
  assert.equal(result.handled, true);
  assert.match(capturedUser, /"dateIssueReason":"ambiguous_date"/);
  assert.doesNotMatch(capturedSystem, /not (a )?real calendar date/i);
});

// ---------------------------------------------------------------------------
// TEST 5 — valid future date: unaffected by this fix.
// ---------------------------------------------------------------------------

test("5. valid future date (3 September): resolves normally, no temporal_unresolved, exact Sep3->Sep5 window", async () => {
  const message = "Corolla 3 September se 2 din ke liye available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } } })),
      { customerMessage: message, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }] }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision, {}, { id: "corolla", name: "Corolla" });
  assert.notEqual(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical.verified.availability.temporalUnresolvedReason ?? null, null);
  assert.equal(canonical.verified.availability.requestedStartAt, SEP3_START_ISO);
  assert.equal(canonical.verified.availability.requestedEndAt, SEP5_END_ISO);
});

// ---------------------------------------------------------------------------
// TEST 6 — invalid -> corrected date continuation: preserves Corolla,
// duration=2, exact Sep3->Sep5 window (already-working continuation logic,
// untouched by this fix, re-proven here through the real writer/reader path).
// ---------------------------------------------------------------------------

test("6. invalid date corrected on the next turn: Corolla + duration=2 retained, exact Sep3->Sep5 window, no technical fallback", async () => {
  const sessionKey = "session-invalid-corrected";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message1, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } } })),
      { customerMessage: message1, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }] }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-6-1", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message: message1, messageId: "wamid.6-1",
    catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }],
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
    }) } }] }),
  });
  assert.equal(result1.handled, true);
  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: result1.messageMeta.actionPlan, sourceTurnId: "assistant:wamid.6-1", outboundDelivered: true });
  const snapshot = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: "923001234567" });
  assert.equal(trustedFocus?.itemId, "corolla");

  const message2 = "3 September se";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
      temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
    })),
    { customerMessage: message2, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }], trustedFreshItemFocus: trustedFocus }
  );
  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: "corolla", name: "Corolla" });
  assert.equal(canonical2.resolvedItem?.id, "corolla");
  assert.equal(canonical2.turn?.durationDays, 2);
  assert.equal(canonical2.verified.availability.requestedStartAt, SEP3_START_ISO);
  assert.equal(canonical2.verified.availability.requestedEndAt, SEP5_END_ISO);

  const plan2 = planFor(message2, canonical2, "corolla", "Corolla");
  const ownerCheck2 = plan2.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerCheck2, "expected owner-check to proceed once the date is corrected");
  assert.equal(ownerCheck2.payload.requestedStartAt, SEP3_START_ISO);
  assert.equal(ownerCheck2.payload.requestedEndAt, SEP5_END_ISO);
});

// ---------------------------------------------------------------------------
// TEST 7 — repeated invalid correction: still invalid_date reason, focus and
// duration preserved, no technical fallback.
// ---------------------------------------------------------------------------

test("7. repeated invalid correction ('31 feburary sy' again): still reason=invalid_date, Corolla + duration=2 preserved", async () => {
  const sessionKey = "session-repeated-invalid";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message1, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } } })),
      { customerMessage: message1, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }] }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-7-1", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message: message1, messageId: "wamid.7-1",
    catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }],
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
    }) } }] }),
  });
  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: result1.messageMeta.actionPlan, sourceTurnId: "assistant:wamid.7-1", outboundDelivered: true });
  const snapshot = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: "923001234567" });

  const message2 = "31 feburary sy";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
      temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
    })),
    { customerMessage: message2, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }], trustedFreshItemFocus: trustedFocus }
  );
  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: "corolla", name: "Corolla" });
  assert.equal(canonical2.resolvedItem?.id, "corolla");
  assert.equal(canonical2.turn?.durationDays, 2);
  assert.equal(canonical2.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.equal(canonical2.verified.availability.temporalUnresolvedReason, "invalid_date");

  const plan2 = planFor(message2, canonical2, "corolla", "Corolla");
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.source, "canonical_owner_check_ask_temporal_clarification");
  assert.equal(plan2.persistenceIntent.rememberPendingTemporalClarification, true);
  assert.equal(plan2.persistenceIntent.pendingTemporalClarification?.durationDays, 2);
});

// ---------------------------------------------------------------------------
// TEST 8 — fresh explicit duration overrides stored duration on correction.
// ---------------------------------------------------------------------------

test("8. fresh explicit duration on the corrected turn overrides the stored pendingTemporalClarification duration", async () => {
  const sessionKey = "session-fresh-duration-override";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message1, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } } })),
      { customerMessage: message1, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }] }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-8-1", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message: message1, messageId: "wamid.8-1",
    catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }],
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
    }) } }] }),
  });
  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: result1.messageMeta.actionPlan, sourceTurnId: "assistant:wamid.8-1", outboundDelivered: true });
  const snapshot = peekEmilySessionState(sessionKey);
  assert.equal(snapshot.pendingTemporalClarification?.durationDays, 2);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: snapshot, participantKey: "923001234567" });

  const message2 = "3 September se 4 din";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
      temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
    })),
    { customerMessage: message2, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }], trustedFreshItemFocus: trustedFocus }
  );
  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, snapshot, { id: "corolla", name: "Corolla" });
  assert.equal(canonical2.turn?.durationDays, 4, "fresh explicit duration (4) must win over the stored pendingTemporalClarification duration (2)");
  assert.equal(canonical2.duration?.source, "explicit");
});

// ---------------------------------------------------------------------------
// TEST 9 — item switch does not leak the pending temporal clarification.
// ---------------------------------------------------------------------------

test("9. item switch to a fresh explicit item does not leak the stored Corolla pendingTemporalClarification", async () => {
  const sessionKey = "session-item-switch-no-leak";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message1, "Corolla")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } } })),
      { customerMessage: message1, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }, { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL }] }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-9-1", businessId: "biz", channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false,
    participantPhoneForDm: "923001234567", message: message1, messageId: "wamid.9-1",
    catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }, { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL }],
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
    }) } }] }),
  });
  applySessionMemoryFromActionPlan({ sessionKey, actionPlan: result1.messageMeta.actionPlan, sourceTurnId: "assistant:wamid.9-1", outboundDelivered: true });
  const snapshot = peekEmilySessionState(sessionKey);
  assert.equal(snapshot.pendingTemporalClarification?.itemId, "corolla");

  // Fresh explicit Civic, no duration restated.
  const message2 = "Civic 3 September se available hai?";
  const decision2 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ itemReferents: [span(message2, "Civic")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } } })),
      { customerMessage: message2, catalogItems: [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }, { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL }] }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical2 = await resolveCanonical(message2, decision2, snapshot, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID);
  assert.notEqual(canonical2.turn?.durationDays, 2, "Corolla's stored 2-day pendingTemporalClarification must not transfer to Civic");
  assert.notEqual(canonical2.duration?.source, "temporal_clarification_continuation");
});
