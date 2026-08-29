/**
 * Coordinated Cloud DM stabilization batch — production-like round-trip
 * regressions for the four confirmed P0/P1 defect groups:
 *   D1/D2 — context/item continuity (trusted fresh item focus)
 *   D3    — booking window persistence (AVR window -> createBooking)
 *   D5    — atomic customer-confirm-processing claim
 * These tests exercise the REAL writer -> persistence -> reader chain
 * (sessionMemoryExecutor, conversationIntelligence session state,
 * availabilityRequestService, createBookingExecutor) rather than injecting
 * already-correct state synthetically.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { parseCloudDmOwnershipDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { buildPricingInquiryActionPlan } from "../src/brain/workflows/PricingInquiryWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveCloudDmOwnershipTrustedFocus } from "../src/services/whatsappInboundBuffer.js";
import {
  createAvailabilityRequest,
  getAvailabilityRequest,
  claimAvailabilityRequestCustomerConfirmProcessing,
} from "../src/services/availabilityRequestService.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";

const BUSINESS_ID = "biz-stabilization-batch";
const CUSTOMER_PHONE = "923001234567";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CIVIC_ID = "honda_civic";
const CIVIC_LABEL = "Honda Civic";
const CATALOG = [
  { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL },
  { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL },
];
const NOW_MS = Date.parse("2026-08-29T08:56:40.913Z");
const SEP3_START_ISO = "2026-09-02T19:00:00.000Z";
const SEP5_END_ISO = "2026-09-04T19:00:00.000Z";
const SEP3_PLUS_1_DAY_ISO = "2026-09-03T19:00:00.000Z";

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

function turnContextInputFor(messageId) {
  return {
    chatType: "dm",
    chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
    participantKey: CUSTOMER_PHONE,
    participantPhone: CUSTOMER_PHONE,
    sourceMessageId: messageId,
    guaranteeKey: messageId,
    authoritativeItem: { id: COROLLA_ID, name: COROLLA_LABEL },
  };
}

async function resolveCanonical(message, canonicalSemanticDecision, memorySnapshot = {}) {
  return resolveBusinessTurnContext({
    traceId: "t-stabilization",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: turnContextInputFor("m1"),
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      schemaVersion: 1,
      memorySnapshot,
      canonicalSemanticDecision,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

/**
 * Turn 1 shared by the temporal-clarification-continuation tests: Corolla,
 * duration=2 known, date invalid (31 Feb) -> temporal_unresolved clarification.
 * Runs the REAL pipeline + REAL post-send session-memory write, exactly as
 * production does, and returns the real persisted state + trusted focus.
 */
async function seedTemporalClarificationTurn1(sessionKey, traceSuffix) {
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(
        baseDecision({
          itemReferents: [span(message1, "Corolla")],
          temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
        })
      ),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: `t-${traceSuffix}-1`,
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message: message1,
    messageId: `wamid.${traceSuffix}-1`,
    catalogItems: CATALOG,
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Corolla kis date se chahiye?",
              replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
              customerInputRequested: true,
              requestedInput: "start_date",
              availabilityCheckStarted: false,
            }),
          },
        },
      ],
    }),
  });
  assert.equal(result1.handled, true);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: result1.messageMeta.actionPlan,
    sourceTurnId: `assistant:wamid.${traceSuffix}-1`,
    outboundDelivered: true,
  });
  const persistedState = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: persistedState,
    participantKey: CUSTOMER_PHONE,
    nowMs: NOW_MS + 5000,
  });
  return { persistedState, trustedFocus };
}

// ---------------------------------------------------------------------------
// A/B/C — Fix 1: context/item continuity, real writer -> persistence -> reader.
// ---------------------------------------------------------------------------

test("A. temporal clarification context round-trip: real session persistence preserves trusted Corolla focus into the corrected-date turn", async () => {
  const sessionKey = "session-A-temporal-context";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";

  // Turn 1: real workflow branch -> real action plan -> real session persistence.
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(
        baseDecision({
          itemReferents: [span(message1, "Corolla")],
          temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
        })
      ),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };

  let composeCalls1 = 0;
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-A-1",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message: message1,
    messageId: "wamid.A-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => {
      composeCalls1 += 1;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Corolla kis date se chahiye?",
                replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
                customerInputRequested: true,
                requestedInput: "start_date",
                availabilityCheckStarted: false,
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result1.handled, true);
  assert.equal(composeCalls1, 1);
  assert.equal(result1.reply, "Corolla kis date se chahiye?");

  // Real production write path: exactly what whatsappInboundBuffer.js does
  // after a successful WhatsApp send (outboundDelivered:true), using the
  // REAL action plan the pipeline produced -- no synthetic memory injected.
  assert.equal(result1.messageMeta?.actionPlan?.persistenceIntent?.rememberPresentedItemFocus, true);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: result1.messageMeta.actionPlan,
    sourceTurnId: "assistant:wamid.A-1",
    outboundDelivered: true,
  });

  // Real read-back through the same accessor production uses.
  const persistedState = peekEmilySessionState(sessionKey);
  assert.ok(persistedState?.lastFreshItemFocus, "expected a persisted trusted fresh item focus");
  assert.equal(persistedState.lastFreshItemFocus.itemId, COROLLA_ID);

  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: persistedState,
    participantKey: CUSTOMER_PHONE,
    nowMs: NOW_MS + 5000,
  });
  assert.ok(trustedFocus, "expected resolveCloudDmOwnershipTrustedFocus to return the persisted focus");
  assert.equal(trustedFocus.itemId, COROLLA_ID);

  // Turn 2: the customer answers with ONLY the corrected date, no item name.
  const message2 = "3 September se";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
        itemReferenceMode: "CONTEXTUAL",
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      })
    ),
    {
      customerMessage: message2,
      catalogItems: CATALOG,
      trustedFreshItemFocus: trustedFocus,
      onStructuralRejection: (d) => {
        rejection = d;
      },
    }
  );
  // The exact live-proven failure mode this fix closes: no
  // ITEM_REFERENT_SURFACE_MISMATCH, no fabricated current_turn span.
  assert.equal(rejection, null, "ownership must not structurally reject the contextual continuation");
  assert.ok(parsed2, "expected a valid parsed decision for the contextual follow-up");
  assert.equal(parsed2.itemReferents[0].trustedItemId, COROLLA_ID);
  assert.equal(parsed2.temporalRequest.startDateKind, "explicit_date");

  // Turn 1's known duration (2) must have been captured on its own narrow,
  // item-scoped carrier -- not the generic session/assist mechanisms.
  assert.equal(persistedState.pendingTemporalClarification?.itemId, COROLLA_ID);
  assert.equal(persistedState.pendingTemporalClarification?.durationDays, 2);
  assert.equal(persistedState.lastAvailabilityAssist ?? null, null, "must not overload lastAvailabilityAssist");

  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, persistedState);
  const av2 = canonical2.verified.availability;
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID);
  assert.equal(av2.dateWindowConfidence, "explicit_calendar_date");
  // Known duration (2) survives specifically through the clarification
  // continuation -- exact Sep3->Sep5 window, not a 1-day guess.
  assert.equal(canonical2.turn?.durationDays, 2);
  assert.equal(canonical2.duration?.source, "temporal_clarification_continuation");
  assert.equal(av2.requestedStartAt, SEP3_START_ISO);
  assert.equal(av2.requestedEndAt, SEP5_END_ISO);

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: { turnId: "t2", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() },
      idempotencyKey: "idem2",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      itemSource: "explicit",
      askedField: "availability",
      durationDays: canonical2.turn?.durationDays ?? null,
      signals: { availabilityAsk: false, bookingCommitment: false },
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  // No duration_ask, no repeat of temporal_clarification, no technical
  // fallback -- normal owner-check/availability flow continues with the
  // known duration and the exact resolved window.
  const owner2 = (plan2.actions || []).find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner2, "expected owner-check to proceed with the known duration, not a duration_ask");
  assert.equal(owner2.payload.itemId, COROLLA_ID);
  assert.equal(owner2.payload.durationDays, 2);
  assert.equal(owner2.payload.requestedStartAt, SEP3_START_ISO);
  assert.equal(owner2.payload.requestedEndAt, SEP5_END_ISO);
  const reply2 = (plan2.actions || []).find((a) => a.type === "REPLY");
  assert.notEqual(reply2?.payload?.source, "canonical_owner_check_ask_duration");
  assert.notEqual(reply2?.payload?.source, "canonical_owner_check_ask_temporal_clarification");
  assert.notEqual(reply2?.payload?.source, "canonical_technical_fallback");

  // Leaving the clarification flow (owner-check now proceeding) clears the
  // narrow carrier -- it must not survive beyond the clarification itself.
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan2,
    sourceTurnId: "assistant:wamid.A-2",
    outboundDelivered: true,
  });
  const stateAfterResolution = peekEmilySessionState(sessionKey);
  assert.equal(stateAfterResolution.pendingTemporalClarification ?? null, null);
});

test("B. repeated invalid date after clarification: contextual Corolla stays bound, no fabricated current_turn item, no technical fallback", async () => {
  const sessionKey = "session-B-repeated-invalid";
  const message1 = "Corolla 31 February se 2 din ke liye available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(
        baseDecision({
          itemReferents: [span(message1, "Corolla")],
          temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
        })
      ),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-B-1",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message: message1,
    messageId: "wamid.B-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Corolla kis date se chahiye?",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        customerInputRequested: true, requestedInput: "start_date", availabilityCheckStarted: false,
      }) } }],
    }),
  });
  assert.equal(result1.handled, true);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: result1.messageMeta.actionPlan,
    sourceTurnId: "assistant:wamid.B-1",
    outboundDelivered: true,
  });
  const persistedState = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: persistedState, participantKey: CUSTOMER_PHONE, nowMs: NOW_MS + 5000 });
  assert.equal(trustedFocus.itemId, COROLLA_ID);

  // Customer repeats the SAME invalid date, still itemless.
  const message2 = "31 feburary sy";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
        itemReferenceMode: "CONTEXTUAL",
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
      })
    ),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus, onStructuralRejection: (d) => { rejection = d; } }
  );
  assert.equal(rejection, null, "no fabricated current_turn item; contextual binding must be accepted");
  assert.equal(parsed2.itemReferents[0].trustedItemId, COROLLA_ID);

  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, persistedState);
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID);
  assert.equal(canonical2.verified.availability.dateWindowConfidence, "temporal_unresolved");
  assert.notEqual(canonical2.verified.availability.dateWindowConfidence, "duration_default_now");
  // Known duration (2) survives the repeated-invalid-date turn too -- it was
  // never a duration question, only ever a date question.
  assert.equal(canonical2.turn?.durationDays, 2);
  assert.equal(canonical2.duration?.source, "temporal_clarification_continuation");

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: COROLLA_ID, resolvedItemLabel: COROLLA_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: false, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  assert.equal((plan2.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.source, "canonical_owner_check_ask_temporal_clarification");
  assert.notEqual(reply2.payload.source, "canonical_owner_check_ask_duration");
  assert.notEqual(reply2.payload.source, "canonical_technical_fallback");
  // Focus must still be preserved for a THIRD attempt too.
  assert.equal(plan2.persistenceIntent.rememberPresentedItemFocus, true);
  // The clarification is REWRITTEN (fresh TTL), not cleared -- it must
  // survive to a possible third attempt, still holding durationDays=2.
  assert.equal(plan2.persistenceIntent.rememberPendingTemporalClarification, true);
  assert.equal(plan2.persistenceIntent.pendingTemporalClarification?.itemId, COROLLA_ID);
  assert.equal(plan2.persistenceIntent.pendingTemporalClarification?.durationDays, 2);

  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan2,
    sourceTurnId: "assistant:wamid.B-2",
    outboundDelivered: true,
  });
  const stateAfterRepeat = peekEmilySessionState(sessionKey);
  assert.equal(stateAfterRepeat.pendingTemporalClarification?.itemId, COROLLA_ID);
  assert.equal(stateAfterRepeat.pendingTemporalClarification?.durationDays, 2);
});

// ---------------------------------------------------------------------------
// Duration-continuation contract: precedence, item-switch safety, expiry,
// and no leakage into unrelated turns.
// ---------------------------------------------------------------------------

test("Duration-continuation C: fresh explicit duration on turn 2 overrides the stored pendingTemporalClarification (4 wins, not 2)", async () => {
  const sessionKey = "session-DurC-fresh-override";
  const { persistedState } = await seedTemporalClarificationTurn1(sessionKey, "DurC");
  assert.equal(persistedState.pendingTemporalClarification?.durationDays, 2);

  const message2 = "3 September se 4 din";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
        itemReferenceMode: "CONTEXTUAL",
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      })
    ),
    {
      customerMessage: message2,
      catalogItems: CATALOG,
      trustedFreshItemFocus: resolveCloudDmOwnershipTrustedFocus({
        memorySnapshot: persistedState,
        participantKey: CUSTOMER_PHONE,
        nowMs: NOW_MS + 5000,
      }),
    }
  );
  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, persistedState);
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID);
  // Fresh explicit duration (4) wins -- stored continuation (2) never applies.
  assert.equal(canonical2.turn?.durationDays, 4);
  assert.equal(canonical2.duration?.source, "explicit");
  assert.notEqual(canonical2.duration?.source, "temporal_clarification_continuation");
  const av2 = canonical2.verified.availability;
  assert.equal(av2.requestedStartAt, SEP3_START_ISO);
  // 4-day window from Sep3, not the stored 2-day window.
  assert.equal(av2.requestedEndAt, "2026-09-06T19:00:00.000Z");
});

test("Duration-continuation D: item switch to Civic does not inherit Corolla's stored clarification duration", async () => {
  const sessionKey = "session-DurD-item-switch";
  const { persistedState } = await seedTemporalClarificationTurn1(sessionKey, "DurD");
  assert.equal(persistedState.pendingTemporalClarification?.itemId, COROLLA_ID);

  // Customer switches to a DIFFERENT item, explicit date, no duration.
  const message2 = "Civic 3 September se";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        itemReferents: [span(message2, "Civic")],
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      })
    ),
    { customerMessage: message2, catalogItems: CATALOG }
  );
  const canonical2 = await resolveCanonical(
    message2,
    { ...parsed2, semanticDecisionStatus: "released" },
    persistedState
  );
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID, "Civic must be authoritative for this turn");
  // Corolla's stored 2-day clarification duration must NOT transfer to Civic.
  assert.notEqual(canonical2.turn?.durationDays, 2);
  assert.equal(canonical2.turn?.durationDays ?? null, null);
  assert.notEqual(canonical2.duration?.source, "temporal_clarification_continuation");

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: false, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  // No cross-item leakage: Civic gets its own duration_ask (duration unknown
  // for Civic), never an owner-check built from Corolla's 2-day duration.
  assert.equal((plan2.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.itemId, CIVIC_ID);
  assert.equal(reply2.payload.source, "canonical_owner_check_ask_duration");
});

test("Duration-continuation E: expired pendingTemporalClarification is not recovered on a date-only continuation", async () => {
  const sessionKey = "session-DurE-expiry";
  const { persistedState } = await seedTemporalClarificationTurn1(sessionKey, "DurE");
  assert.equal(persistedState.pendingTemporalClarification?.itemId, COROLLA_ID);

  // Force the stored record into the past -- simulates TTL expiry.
  const expiredState = {
    ...persistedState,
    pendingTemporalClarification: {
      ...persistedState.pendingTemporalClarification,
      expiresAt: new Date(NOW_MS - 60_000).toISOString(),
    },
  };

  const message2 = "3 September se";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
        itemReferenceMode: "CONTEXTUAL",
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      })
    ),
    {
      customerMessage: message2,
      catalogItems: CATALOG,
      trustedFreshItemFocus: resolveCloudDmOwnershipTrustedFocus({
        memorySnapshot: persistedState,
        participantKey: CUSTOMER_PHONE,
        nowMs: NOW_MS + 5000,
      }),
    }
  );
  const canonical2 = await resolveCanonical(
    message2,
    { ...parsed2, semanticDecisionStatus: "released" },
    expiredState
  );
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID);
  // Expired -- duration must NOT be recovered from the stale record.
  assert.equal(canonical2.turn?.durationDays ?? null, null);
  assert.notEqual(canonical2.duration?.source, "temporal_clarification_continuation");
});

test("Duration-continuation F: an ordinary contextual turn not resolving the clarification cannot read the stored duration", async () => {
  const sessionKey = "session-DurF-unrelated";
  const { persistedState } = await seedTemporalClarificationTurn1(sessionKey, "DurF");
  assert.equal(persistedState.pendingTemporalClarification?.itemId, COROLLA_ID);

  // An ordinary itemless follow-up with NO temporal signal at all (a price
  // question) -- still within the TTL, same item via trusted focus.
  const message2 = "iska rent kitna hai?";
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(
      baseDecision({
        semanticIntent: "pricing_inquiry",
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
        itemReferenceMode: "CONTEXTUAL",
      })
    ),
    {
      customerMessage: message2,
      catalogItems: CATALOG,
      trustedFreshItemFocus: resolveCloudDmOwnershipTrustedFocus({
        memorySnapshot: persistedState,
        participantKey: CUSTOMER_PHONE,
        nowMs: NOW_MS + 5000,
      }),
    }
  );
  const canonical2 = await resolveCanonical(
    message2,
    { ...parsed2, semanticDecisionStatus: "released" },
    persistedState
  );
  assert.equal(canonical2.resolvedItem?.id, COROLLA_ID);
  // No temporal signal on this turn -> the clarification's duration must
  // not leak into an unrelated price question, even for the same item.
  assert.equal(canonical2.turn?.durationDays ?? null, null);
  assert.notEqual(canonical2.duration?.source, "temporal_clarification_continuation");
});

test("C. plain context continuation (pricing-answer branch): real session memory provides trusted item focus for an itemless follow-up", async () => {
  const understanding = {
    resolvedItemId: COROLLA_ID,
    resolvedItemLabel: COROLLA_LABEL,
    durationDays: null,
    signals: { priceAsk: true },
  };
  const plan = buildPricingInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: "Corolla ka rate kya hai?", normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding,
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL },
        verified: { pricing: { status: "resolved", daily: 8000, hasPricing: true } },
      },
    },
  });
  assert.equal(plan.persistenceIntent.rememberPresentedItemFocus, true);
  assert.equal(plan.persistenceIntent.presentedItemId, COROLLA_ID);

  const sessionKey = "session-C-pricing-context";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan,
    sourceTurnId: "assistant:wamid.C-1",
    outboundDelivered: true,
  });
  const persistedState = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: persistedState, participantKey: CUSTOMER_PHONE, nowMs: NOW_MS + 1000 });
  assert.ok(trustedFocus, "expected trusted focus after a plain single-item price answer");
  assert.equal(trustedFocus.itemId, COROLLA_ID);
});

// ---------------------------------------------------------------------------
// D — Fix 2: booking must use the trusted approved window.
// ---------------------------------------------------------------------------

class MemDoc {
  constructor(store, parts) { this.store = store; this.parts = parts; }
  get id() { return this.parts[this.parts.length - 1]; }
  get path() { return this.parts.join("/"); }
  async get() {
    const data = this.store.get(this.path);
    // Shallow-copy only: a deep/structuredClone would strip Firestore
    // Timestamp instances down to plain {_seconds,_nanoseconds} objects,
    // losing .toDate()/.toMillis() -- exactly the shape real Firestore
    // does NOT return, so keep field values (including Timestamps) intact.
    return { exists: data != null, id: this.id, data: () => (data ? { ...data } : undefined) };
  }
  async set(data, options = {}) {
    const prior = this.store.get(this.path) || {};
    this.store.set(this.path, options.merge ? { ...prior, ...data } : { ...data });
  }
  async update(data) {
    const prior = this.store.get(this.path) || {};
    this.store.set(this.path, { ...prior, ...data });
  }
  collection(name) { return new MemCol(this.store, [...this.parts, name]); }
}
let memDocAutoId = 0;
class MemQuery {
  constructor(store, parts, field, op, value) {
    this.store = store; this.parts = parts; this.field = field; this.op = op; this.value = value;
  }
  async get() {
    const prefix = `${this.parts.join("/")}/`;
    const docs = [];
    for (const [path, data] of this.store.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/")) continue;
      if (this.field && this.op === "==" && data?.[this.field] !== this.value) continue;
      docs.push({ id: path.slice(prefix.length), data: () => ({ ...data }) });
    }
    return { docs, empty: docs.length === 0 };
  }
}
class MemCol {
  constructor(store, parts) { this.store = store; this.parts = parts; }
  doc(id) {
    const docId = id != null ? String(id) : `auto-${++memDocAutoId}`;
    return new MemDoc(this.store, [...this.parts, docId]);
  }
  where(field, op, value) { return new MemQuery(this.store, this.parts, field, op, value); }
}
class MemDb {
  constructor() { this.docs = new Map(); this._txQueue = Promise.resolve(); }
  collection(name) { return new MemCol(this.docs, [name]); }
  // Real Firestore transactions serialize conflicting readers/writers via
  // optimistic concurrency + retry. This fake instead serializes the whole
  // transaction body per db instance, which is sufficient to prove the
  // claim's own check-then-set logic is atomic without re-implementing
  // Firestore's commit protocol.
  runTransaction(fn) {
    const run = () =>
      fn({
        get: (ref) => ref.get(),
        set: (ref, data, options) => ref.set(data, options),
        update: (ref, data) => ref.update(data),
      });
    const result = this._txQueue.then(run, run);
    this._txQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

test("D. booking created from a trusted waiting_confirm AVR uses the AVR's exact window, not now()+duration", async () => {
  const db = new MemDb();
  const created = await createAvailabilityRequest({
    db,
    payload: {
      businessId: BUSINESS_ID,
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 2,
      requestedStartAt: SEP3_START_ISO,
      requestedEndAt: SEP5_END_ISO,
      canonicalAvailabilityStatus: "available",
      sourceIdentity: { chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`, chatType: "dm", participantPhone: CUSTOMER_PHONE, sourceTurnKey: "wamid.D-1" },
      sourceTurnKey: "wamid.D-1",
    },
    executionContext: { businessId: BUSINESS_ID, executionGuard: { active: true }, db },
  });
  assert.equal(created.ok, true);

  // Simulate the owner-approved, customer-notified, waiting_confirm state the
  // real confirm gate checks.
  const key = `businesses/${BUSINESS_ID}/availabilityRequests/${created.requestId}`;
  const doc = db.docs.get(key);
  db.docs.set(key, {
    ...doc,
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    customerConfirmationStatus: "waiting_confirm",
  });

  let capturedCreateArgs = null;
  const result = await executeCreateBooking({
    payload: { itemId: COROLLA_ID, itemLabel: COROLLA_LABEL, durationDays: 2, availabilityRequestId: created.requestId },
    executionContext: {
      businessId: BUSINESS_ID,
      db,
      traceId: "t-D-1",
      participantPhoneForDm: CUSTOMER_PHONE,
      __createBookingForTests: async (traceId, userId, opts) => {
        capturedCreateArgs = opts;
        return {
          ok: true,
          id: "booking-D-1",
          itemId: opts.itemId,
          startAt: opts.requestedStartAt,
          endAt: opts.requestedEndAt,
        };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedCreateArgs.requestedStartAt.toISOString(), SEP3_START_ISO);
  assert.equal(capturedCreateArgs.requestedEndAt.toISOString(), SEP5_END_ISO);
});

test("D2. createBooking itself anchors startAt/endAt to the trusted requested window (real function, not the test double)", async () => {
  const db = new MemDb();
  db.docs.set("businesses/biz-D2", { businessId: "biz-D2" });
  const { createBooking } = await import("../src/services/inventoryService.js");
  const booking = await createBooking("t-D2", "biz-D2", {
    itemId: COROLLA_ID,
    itemName: COROLLA_LABEL,
    durationDays: 2,
    requestedStartAt: SEP3_START_ISO,
    requestedEndAt: SEP5_END_ISO,
    dbOverride: db,
  });
  assert.equal(booking.ok !== false, true, `createBooking failed: ${JSON.stringify(booking)}`);
  assert.equal(new Date(booking.startAt?.toDate ? booking.startAt.toDate() : booking.startAt).toISOString(), SEP3_START_ISO);
  assert.equal(new Date(booking.endAt?.toDate ? booking.endAt.toDate() : booking.endAt).toISOString(), SEP5_END_ISO);
});

test("D3. legacy/no-window booking still falls back to now()+duration when no trusted window exists", async () => {
  const db = new MemDb();
  const { createBooking } = await import("../src/services/inventoryService.js");
  const beforeMs = Date.now();
  const booking = await createBooking("t-D3", "biz-D3", {
    itemId: COROLLA_ID,
    itemName: COROLLA_LABEL,
    durationDays: 3,
    dbOverride: db,
  });
  const afterMs = Date.now();
  assert.equal(booking.ok !== false, true, `createBooking failed: ${JSON.stringify(booking)}`);
  const startMs = (booking.startAt?.toMillis ? booking.startAt.toMillis() : new Date(booking.startAt).getTime());
  const endMs = (booking.endAt?.toMillis ? booking.endAt.toMillis() : new Date(booking.endAt).getTime());
  assert.ok(startMs >= beforeMs - 1000 && startMs <= afterMs + 1000, "legacy booking must still start near now()");
  assert.equal(endMs - startMs, 3 * 86400000);
});

// ---------------------------------------------------------------------------
// E — Fix 3: atomic customer-confirm-processing claim under concurrency.
// ---------------------------------------------------------------------------

test("E. two concurrent confirm-processing claims against the same AVR: exactly one succeeds, lifecycle stays valid", async () => {
  const db = new MemDb();
  const created = await createAvailabilityRequest({
    db,
    payload: {
      businessId: BUSINESS_ID,
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 2,
      canonicalAvailabilityStatus: "available",
      sourceIdentity: { chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`, chatType: "dm", participantPhone: CUSTOMER_PHONE, sourceTurnKey: "wamid.E-1" },
      sourceTurnKey: "wamid.E-1",
    },
    executionContext: { businessId: BUSINESS_ID, executionGuard: { active: true }, db },
  });
  assert.equal(created.ok, true);

  const [first, second] = await Promise.all([
    claimAvailabilityRequestCustomerConfirmProcessing({ db, businessId: BUSINESS_ID, requestId: created.requestId }),
    claimAvailabilityRequestCustomerConfirmProcessing({ db, businessId: BUSINESS_ID, requestId: created.requestId }),
  ]);

  const outcomes = [first, second];
  const successes = outcomes.filter((r) => r.ok === true);
  const failures = outcomes.filter((r) => r.ok === false);
  assert.equal(successes.length, 1, "exactly one concurrent claim must succeed");
  assert.equal(failures.length, 1, "the other concurrent claim must be rejected, not silently duplicated");
  assert.equal(failures[0].reason, "ALREADY_PROCESSING");

  const final = await getAvailabilityRequest({ db, businessId: BUSINESS_ID, requestId: created.requestId });
  assert.equal(final.customerConfirmProcessingStatus, "processing");
});

test("E2. sequential retry after a successful claim is still rejected (unchanged behavior)", async () => {
  const db = new MemDb();
  const created = await createAvailabilityRequest({
    db,
    payload: {
      businessId: BUSINESS_ID,
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 2,
      canonicalAvailabilityStatus: "available",
      sourceIdentity: { chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`, chatType: "dm", participantPhone: CUSTOMER_PHONE, sourceTurnKey: "wamid.E2-1" },
      sourceTurnKey: "wamid.E2-1",
    },
    executionContext: { businessId: BUSINESS_ID, executionGuard: { active: true }, db },
  });
  const first = await claimAvailabilityRequestCustomerConfirmProcessing({ db, businessId: BUSINESS_ID, requestId: created.requestId });
  assert.equal(first.ok, true);
  const second = await claimAvailabilityRequestCustomerConfirmProcessing({ db, businessId: BUSINESS_ID, requestId: created.requestId });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ALREADY_PROCESSING");
});
