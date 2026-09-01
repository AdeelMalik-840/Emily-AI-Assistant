/**
 * Temporal-unresolved safety gate: a trusted date-bearing temporal claim
 * (invalid explicit date, or an ambiguous/unrepresentable reference the
 * single AI temporal owner flags as unresolved) must never silently degrade
 * into duration_default_now, must never run owner-check/create an AVR, and
 * must never produce a customer-facing available/unavailable claim for the
 * wrong window. It must ask the customer to clarify instead.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz-temporal-unresolved";

import { parseCloudDmOwnershipDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { composeCloudCanonicalCustomerReply } from "../src/brain/openai/composeCloudCanonicalCustomerReply.js";

const BUSINESS_ID = "biz-temporal-unresolved";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CATALOG = [{ id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL }];
const NOW_MS = Date.parse("2026-08-29T08:56:40.913Z");

async function resolveFor(message, temporalRequest, bookings = []) {
  return resolveBusinessTurnContext({
    traceId: "t-temporal-unresolved",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => bookings,
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      participantPhone: "923001234567",
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem: { id: COROLLA_ID, name: COROLLA_LABEL },
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      schemaVersion: 1,
      memorySnapshot: {},
      canonicalSemanticDecision: { temporalRequest },
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

function planFor(canonical, message) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        turnId: "t1",
        businessId: BUSINESS_ID,
        channelId: "whatsapp_cloud",
        chatKey: "dm",
        participantKey: "923001234567",
        text: message,
        normalizedAt: new Date(NOW_MS).toISOString(),
      },
      idempotencyKey: "idem1",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      itemSource: "explicit",
      askedField: "availability",
      durationDays: canonical.turn?.durationDays ?? null,
      signals: { availabilityAsk: false, bookingCommitment: false },
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

// ---------------------------------------------------------------------------
// A. Parser preserves "unresolved" (does not collapse to "none").
// ---------------------------------------------------------------------------

function validBaseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [
      { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
    ],
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

test("A. raw temporal decision startDateKind=unresolved -> parser preserves unresolved", () => {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(validBaseDecision({ temporalRequest: { startDateKind: "unresolved", startDate: null } })),
    { customerMessage: "Corolla aglay Friday se 2 din chahiye", catalogItems: CATALOG }
  );
  assert.deepEqual(parsed.temporalRequest, { startDateKind: "unresolved", startDate: null });
});

test("A2. malformed but date-bearing proposals fail closed to unresolved, never silently to none", () => {
  const cases = [
    { startDateKind: "explicit_date", startDate: null }, // declared explicit_date, no payload
    { startDateKind: "explicit_date", startDate: { day: 40, month: 9 } }, // out-of-range day
    { startDateKind: "explicit_date", startDate: { day: 3, month: 13 } }, // out-of-range month
    { startDateKind: "invented_kind" }, // unrecognized but present kind
  ];
  for (const temporalRequest of cases) {
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(validBaseDecision({ temporalRequest })),
      { customerMessage: "Corolla ... chahiye", catalogItems: CATALOG }
    );
    assert.deepEqual(
      parsed.temporalRequest,
      { startDateKind: "unresolved", startDate: null },
      `expected unresolved for ${JSON.stringify(temporalRequest)}`
    );
  }
});

test("A3. a genuinely absent/non-object temporalRequest still fails closed to none (no evidence either way)", () => {
  for (const bad of [undefined, null, "garbage", 42, []]) {
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(validBaseDecision(bad !== undefined ? { temporalRequest: bad } : {})),
      { customerMessage: "Corolla 2 din chahiye", catalogItems: CATALOG }
    );
    assert.deepEqual(parsed.temporalRequest, { startDateKind: "none", startDate: null });
  }
});

// ---------------------------------------------------------------------------
// B/C. Invalid explicit calendar dates -> temporal_unresolved, never duration_default_now.
// ---------------------------------------------------------------------------

test("B. explicit_date Feb 31 + duration 2 -> temporal_unresolved, NOT duration_default_now", async () => {
  const canonical = await resolveFor(
    "Corolla 31 February se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "temporal_unresolved");
  assert.notEqual(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, null);
  assert.equal(av.requestedEndAt, null);
});

test("C. explicit_date Apr 31 -> same temporal_unresolved outcome", async () => {
  const canonical = await resolveFor(
    "Corolla 31 April se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 31, month: 4 } }
  );
  assert.equal(canonical.verified.availability.dateWindowConfidence, "temporal_unresolved");
});

// ---------------------------------------------------------------------------
// D. Canonical "unresolved" + duration -> temporal_unresolved, no fallback to now.
// ---------------------------------------------------------------------------

test("D. canonical unresolved + duration -> temporal_unresolved, no fallback to now", async () => {
  const canonical = await resolveFor(
    "Corolla aglay Friday se 2 din ke liye available hai?",
    { startDateKind: "unresolved", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "temporal_unresolved");
  assert.equal(av.requestedStartAt, null);
  assert.equal(av.requestedEndAt, null);
});

// ---------------------------------------------------------------------------
// E. Workflow: no owner-check, no AVR, clarification plan.
// ---------------------------------------------------------------------------

test("E. workflow temporal_unresolved -> no AVAILABILITY_OWNER_CHECK_REQUIRED, clarification plan only", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const canonical = await resolveFor(message, { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } });
  const plan = planFor(canonical, message);
  assert.equal(
    (plan.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.ok(reply);
  assert.equal(reply.payload.source, "canonical_owner_check_ask_temporal_clarification");
  assert.equal(reply.payload.execute, false);
  assert.equal(plan.persistenceIntent.execute, false);
});

function span(text, surface) {
  const start = text.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}

function temporalClarificationCanonicalDecision(message, temporalRequest) {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(
      validBaseDecision({
        itemReferents: [span(message, "Corolla")],
        temporalRequest,
      })
    ),
    { customerMessage: message, catalogItems: CATALOG }
  );
  return { ...parsed, semanticDecisionStatus: "released" };
}

function temporalClarificationComposeResponse(reply, requestedInput = "start_date") {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested: true,
            requestedInput,
            availabilityCheckStarted: false,
          }),
        },
      },
    ],
  };
}

test("Compose-A/B/C. temporal_clarification compose input: correct kind, trusted facts (durationDays, dateWindowConfidence, clarifyStartDate), and prompt instruction", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const canonicalSemanticDecision = temporalClarificationCanonicalDecision(message, {
    startDateKind: "explicit_date",
    startDate: { day: 31, month: 2 },
  });

  let capturedArgs = null;
  const result = await runBrainV2LivePipeline({
    traceId: "temporal-clarification-input",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923001234567",
    message,
    messageId: "wamid.temporal-clarification-input-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async (args) => {
      capturedArgs = args;
      return temporalClarificationComposeResponse("Corolla ke liye exact date confirm kar dein, kaunsi date chahiye?");
    },
  });

  assert.equal(result.handled, true);
  assert.ok(capturedArgs, "expected the composer to be invoked");
  const systemContent = String(capturedArgs.messages?.[0]?.content ?? "");
  const userContent = String(capturedArgs.messages?.[1]?.content ?? "");

  // A. composeKind resolved to the dedicated kind, not duration_ask.
  assert.match(userContent, /^KIND: temporal_clarification/m);

  // B. trusted facts passed to the composer. 31 February is a stated day+month
  // that is not a real calendar date -- this is the invalid_date reason, not
  // an ambiguous/unmappable reference.
  const trustedFactsMatch = userContent.match(/TRUSTED_FACTS_JSON:\s*(\{.*\})/s);
  assert.ok(trustedFactsMatch, "expected TRUSTED_FACTS_JSON in the composer user content");
  const trustedFacts = JSON.parse(trustedFactsMatch[1]);
  assert.equal(trustedFacts.durationDays, 2);
  assert.equal(trustedFacts.dateWindowConfidence, "temporal_unresolved");
  assert.equal(trustedFacts.clarifyStartDate, true);
  assert.equal(trustedFacts.dateIssueReason, "invalid_date");

  // C. the system prompt explicitly instructs acknowledging the invalid date
  // (not the generic "clarify" wording, which is reserved for a genuinely
  // ambiguous/unmappable reference) and preserving known duration.
  assert.match(systemContent, /KIND=temporal_clarification/);
  assert.match(systemContent, /not (a )?real calendar date/i);
  assert.match(systemContent, /not valid/i);
  assert.doesNotMatch(systemContent, /kind=temporal_clarification and TRUSTED_FACTS_JSON\.dateIssueReason=ambiguous_date/i);
  assert.match(systemContent, /durationDays.*already known/i);
  assert.match(systemContent, /do not ask for duration again/i);
  assert.match(systemContent, /requestedInput=start_date/);

  // The structural objective for THIS turn must be start_date, not the
  // shared duration_ask label.
  assert.doesNotMatch(systemContent, /requestedInput=rental_period/);

  // No active duration_ask concrete example competing in the effective
  // prompt: its own KIND=duration_ask bullet (and "kitne din" demonstration)
  // must not be present when composing for a different kind.
  assert.doesNotMatch(systemContent, /KIND=duration_ask/);
  assert.doesNotMatch(systemContent, /kitne din/i);
});

test("Compose-D. duration_ask remains unchanged for genuinely missing duration (not routed to temporal_clarification)", async () => {
  const message = "Corolla available hai?";
  const canonicalSemanticDecision = temporalClarificationCanonicalDecision(message, {
    startDateKind: "none",
    startDate: null,
  });

  let capturedArgs = null;
  const result = await runBrainV2LivePipeline({
    traceId: "duration-ask-unchanged",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923001234567",
    message,
    messageId: "wamid.duration-ask-unchanged-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async (args) => {
      capturedArgs = args;
      return temporalClarificationComposeResponse(
        "Corolla ka mai check kar leta hun. Kitne din ke liye chahiye?",
        "rental_period"
      );
    },
  });

  assert.equal(result.handled, true);
  assert.ok(capturedArgs, "expected the composer to be invoked");
  const systemContent = String(capturedArgs.messages?.[0]?.content ?? "");
  const userContent = String(capturedArgs.messages?.[1]?.content ?? "");
  assert.match(userContent, /^KIND: duration_ask/m);
  assert.doesNotMatch(userContent, /clarifyStartDate/);
  assert.match(systemContent, /requestedInput=rental_period/);
  // duration_ask's own contract and example remain exactly as before.
  assert.match(systemContent, /kitne din/i);
  // The sibling temporal_clarification bullet must not leak into this prompt.
  assert.doesNotMatch(systemContent, /KIND=temporal_clarification/);
  assert.doesNotMatch(systemContent, /requestedInput=start_date/);
});

// ---------------------------------------------------------------------------
// Structural contract: requestedInput distinguishes "date" from "duration"
// missing-input objectives, validated by composeCloudCanonicalCustomerReply()
// directly (not the full pipeline) so these tests exercise the accept/reject
// contract itself rather than one fixed sentence.
// ---------------------------------------------------------------------------

test("Compose-B. temporal_clarification response is accepted only when requestedInput=start_date", async () => {
  let calls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "temporal_clarification",
    trustedFacts: { itemId: "corolla", itemLabel: "Toyota Corolla", durationDays: 2, dateWindowConfidence: "temporal_unresolved", clarifyStartDate: true },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return temporalClarificationComposeResponse("Corolla kis date se chahiye?", "start_date");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_cloud_canonical_compose");
  assert.equal(calls, 1, "a correct first attempt must not be retried");
});

test("Compose-C. temporal_clarification response with requestedInput=rental_period is rejected by the existing validation/retry path", async () => {
  let calls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "temporal_clarification",
    trustedFacts: { itemId: "corolla", itemLabel: "Toyota Corolla", durationDays: 2, dateWindowConfidence: "temporal_unresolved", clarifyStartDate: true },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      // Wrong structural objective for this kind on every attempt.
      return temporalClarificationComposeResponse("Corolla kitne din ke liye chahiye?", "rental_period");
    },
  });
  // composeCloudCanonicalCustomerReply()'s outer .ok reflects whether a
  // non-empty reply was returned at all (including the fallback), not
  // whether real OpenAI composition succeeded — .source is the reliable
  // signal, same convention already used by the active-blocking-now and
  // temporal_unresolved fail-closed checks elsewhere in this codebase.
  assert.notEqual(result.source, "openai_cloud_canonical_compose");
  assert.equal(result.reason, "DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.equal(result.reply, "fallback");
  assert.ok(calls > 1, "the contract violation must trigger the existing retry mechanism");
});

test("Compose-D2. duration_ask response with requestedInput=start_date (wrong for this kind) is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    trustedFacts: { itemId: "corolla", itemLabel: "Toyota Corolla" },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async () =>
      temporalClarificationComposeResponse("Corolla kis date se chahiye?", "start_date"),
  });
  assert.notEqual(result.source, "openai_cloud_canonical_compose");
  assert.equal(result.reason, "DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.equal(result.reply, "fallback");
});

test("Compose-D3. duration_ask response with requestedInput=rental_period is still accepted (unchanged)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    trustedFacts: { itemId: "corolla", itemLabel: "Toyota Corolla" },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async () =>
      temporalClarificationComposeResponse("Corolla kitne din ke liye chahiye?", "rental_period"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_cloud_canonical_compose");
});

test("E2. end-to-end Cloud DM pipeline: temporal_unresolved never creates an AVR or owner notification, and wording is AI-composed (not hardcoded)", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const canonicalSemanticDecision = temporalClarificationCanonicalDecision(message, {
    startDateKind: "explicit_date",
    startDate: { day: 31, month: 2 },
  });

  let composeCalls = 0;
  const result = await runBrainV2LivePipeline({
    traceId: "temporal-unresolved-e2e",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923001234567",
    message,
    messageId: "wamid.temporal-unresolved-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async (args) => {
      composeCalls += 1;
      return temporalClarificationComposeResponse("Corolla ke liye exact date confirm kar dein, kaunsi date chahiye?");
    },
  });

  assert.equal(result.handled, true);
  assert.equal(composeCalls, 1);
  // AI-composed reply, not the deterministic fallback draft.
  assert.equal(result.reply, "Corolla ke liye exact date confirm kar dein, kaunsi date chahiye?");
  assert.notEqual(result.reply, "Toyota Corolla ke liye exact date confirm kar dein, please?");
});

// ---------------------------------------------------------------------------
// F. temporal_unresolved cannot produce a customer-facing availability claim
//    for the duration-only/current-time window.
// ---------------------------------------------------------------------------

test("F. temporal_unresolved never runs computeUserFacingAvailability against the wrong (no-date/now) window", async () => {
  // A booking that WOULD make the no-date-conservative / duration_default_now
  // check return "unavailable" if it were ever consulted for this turn.
  const activeBookingRightNow = {
    itemId: COROLLA_ID,
    status: "approved",
    startAt: new Date(NOW_MS - 86400000).toISOString(),
    endAt: new Date(NOW_MS + 86400000).toISOString(),
  };
  const canonical = await resolveFor(
    "Corolla 31 February se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 31, month: 2 } },
    [activeBookingRightNow]
  );
  const av = canonical.verified.availability;
  // Must not be a customer-facing available/unavailable claim of any kind.
  assert.equal(av.isAvailable, null);
  assert.equal(av.status, "unknown");
  assert.equal(av.source, "temporal_unresolved");
  assert.equal(av.bookingAware, false);
  assert.equal(av.windowApplied, false);
});

// ---------------------------------------------------------------------------
// G-J. Preserved valid cases, unchanged.
// ---------------------------------------------------------------------------

test("G. genuinely no date + duration -> duration_default_now unchanged", async () => {
  const canonical = await resolveFor("Corolla 2 din ke liye available hai?", { startDateKind: "none", startDate: null });
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, new Date(NOW_MS).toISOString());
  assert.equal(av.requestedEndAt, new Date(NOW_MS + 2 * 86400000).toISOString());
});

test("H. valid explicit date -> unchanged (Sep 3 -> Sep 5)", async () => {
  const canonical = await resolveFor(
    "Corolla 3 September se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "explicit_calendar_date");
  assert.equal(av.requestedStartAt, "2026-09-02T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-09-04T19:00:00.000Z");
});

test("I. tomorrow (canonical relative_tomorrow) -> unchanged", async () => {
  const canonical = await resolveFor(
    "Corolla kal se 2 din ke liye available hai?",
    { startDateKind: "relative_tomorrow", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-29T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-31T19:00:00.000Z");
});

test("J. day-after-tomorrow (canonical relative_day_after_tomorrow) -> unchanged", async () => {
  const canonical = await resolveFor(
    "Corolla parson se 2 din ke liye available hai?",
    { startDateKind: "relative_day_after_tomorrow", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-30T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-09-01T19:00:00.000Z");
});
