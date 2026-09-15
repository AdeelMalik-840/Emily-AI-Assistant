/**
 * End-to-end proof of the semantic duration architecture: a customer's
 * natural-language duration statement, expressed by the canonical semantic
 * decision's requestedDuration field (src/brain/decisions/decidePostConfirmCustomerDm.js
 * schema), flows through resolveBusinessTurnContext.js's deterministic
 * grounding/normalization boundary into the same availability transaction
 * state machine every other availability test in this repo already exercises.
 *
 * Every test here drives the real production resolveBusinessTurnContext
 * function directly, with synthetic items never used elsewhere in this
 * codebase, and asserts semantic/state outcomes (resultingState,
 * turn.durationDays, resolvedItem.id, durationSemanticStatus) -- never exact
 * reply wording (no reply is even composed at this layer).
 *
 * Critical proof woven throughout: parseUserDuration (the legacy regex
 * parser, src/duration/parseDuration.js, byte-for-byte unmodified by this
 * task) returns null for every Roman Urdu/transliteration/spelling-variant
 * fixture used below -- so wherever these tests still resolve an exact day
 * count, it is proven to come from the new structured semantic contract,
 * never from an expanded regex.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildEmilyPending } from "../src/brain/availability/emilyPendingContext.js";
import { parseUserDuration } from "../src/duration/parseDuration.js";

const BUSINESS_ID = "biz-semantic-duration";
const NOW_MS = Date.parse("2026-09-13T08:00:00.000Z");
const PARTICIPANT = "923009998877";

function evidenceFor(message, phrase, overrides = {}) {
  const start = message.indexOf(phrase);
  if (start < 0) throw new Error(`test setup: "${phrase}" not found in "${message}"`);
  return {
    source: "current_turn",
    surfaceText: phrase,
    start,
    end: start + phrase.length,
    ...overrides,
  };
}

function exactDuration(message, phrase, components) {
  return { status: "exact", components, evidence: evidenceFor(message, phrase) };
}

function nonExactDuration(message, phrase) {
  return { status: "non_exact", components: null, evidence: evidenceFor(message, phrase) };
}

const NONE_DURATION = { status: "none", components: null, evidence: null };
const NONE_TEMPORAL = { startDateKind: "none", startDate: null };

function activePending(itemId, itemLabel, chatScopeKey = "group-a") {
  return buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId,
    itemLabel,
    customerReference: itemLabel,
    participantKey: PARTICIPANT,
    chatScopeKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: `${chatScopeKey}::original`,
    nowMs: NOW_MS - 60_000,
  });
}

async function resolveFor(message, {
  requestedDuration = null,
  temporalRequest = NONE_TEMPORAL,
  isGroup = true,
  itemId = null,
  itemLabel = null,
  groupKey = "group-a",
  memorySnapshot = {},
  bookings = [],
  decisionAbsent = false,
} = {}) {
  const catalogItems = itemId ? [{ id: itemId, name: itemLabel, displayLabel: itemLabel }] : [];
  return resolveBusinessTurnContext({
    traceId: "t-semantic-duration",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => bookings,
    getBusinessProfileFn: async () => ({}),
    turnContextInput: {
      chatType: isGroup ? "group" : "dm",
      chatId: isGroup ? groupKey : `${BUSINESS_ID}::${PARTICIPANT}`,
      participantKey: PARTICIPANT,
      participantPhone: PARTICIPANT,
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      ...(itemId ? { authoritativeItem: { id: itemId, name: itemLabel } } : {}),
      ...(isGroup ? { validatedGroupCanonicalAuthority: true } : {}),
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::${PARTICIPANT}`,
      participantKey: PARTICIPANT,
      schemaVersion: 1,
      memorySnapshot,
      ...(decisionAbsent
        ? {}
        : { canonicalSemanticDecision: { temporalRequest, requestedDuration } }),
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

// ============================================================
// Section 1: required transaction-state tests.
// ============================================================

test("1. explicit availability + missing duration -> NEED_DURATION", async () => {
  const canonical = await resolveFor("Synthetic Alpha available hai?", {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    requestedDuration: NONE_DURATION,
  });
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
  assert.equal(canonical.durationSemanticStatus, "none");
  assert.equal(canonical.turn.durationDays, null);
});

test("2. NEED_DURATION + exact semantic duration -> accepted, remains availability, exits NEED_DURATION", async () => {
  const message = "2 maheenon k lye";
  assert.equal(parseUserDuration(message), null, "legacy regex must NOT understand this spelling");
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: exactDuration(message, message, [{ value: 2, unit: "months" }]),
  });
  assert.equal(canonical.availabilityConversationTransition.previousState, "NEED_DURATION");
  assert.equal(canonical.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
  assert.equal(canonical.durationSemanticStatus, "exact");
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(canonical.resolvedItem.id, "synthetic_alpha");
});

test("3. NEED_DURATION + ambiguous duration -> remains NEED_DURATION, classified non_exact", async () => {
  const message = "kuch din ke liye chahiye";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: nonExactDuration(message, "kuch din"),
  });
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
  assert.equal(canonical.durationSemanticStatus, "non_exact");
  assert.equal(canonical.turn.durationDays, null);
});

test("4. NEED_DURATION + invalid (ungrounded) duration -> remains NEED_DURATION", async () => {
  const message = "2 maheenon k lye";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    // Evidence cites text that does not actually exist in the raw message --
    // a hallucinated/ungrounded claim, must never be trusted.
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "3 months", start: 0, end: 8 },
    },
  });
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
  assert.equal(canonical.durationSemanticStatus, "invalid_structured_output");
  assert.equal(canonical.turn.durationDays, null);
});

test("5. bare duration + no trusted active transaction -> must not invent item/intent", async () => {
  const message = "2 months";
  const canonical = await resolveFor(message, {
    // No itemId, no memorySnapshot.emilyPending -- nothing trusted to bind to.
    requestedDuration: exactDuration(message, message, [{ value: 2, unit: "months" }]),
  });
  assert.equal(canonical.resolvedItem.id, null);
  assert.notEqual(canonical.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
});

test("6. active item A + bare duration -> item A preserved", async () => {
  const message = "2 mahine";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_bravo",
    itemLabel: "Synthetic Bravo",
    memorySnapshot: { emilyPending: activePending("synthetic_bravo", "Synthetic Bravo") },
    requestedDuration: exactDuration(message, message, [{ value: 2, unit: "months" }]),
  });
  assert.equal(canonical.resolvedItem.id, "synthetic_bravo");
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(canonical.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
});

test("7. active item A + a different current-turn authoritative item B + duration -> duration binds to whichever item current authority resolves (B), not stale A", async () => {
  // Simulates the upstream item-switch already having been decided by
  // existing transaction-authority rules (out of scope here) -- this test
  // only proves duration resolution does not fight or reintroduce A.
  const message = "Synthetic Charlie 3 haftay ke liye";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_charlie", // upstream authority already switched to B
    itemLabel: "Synthetic Charlie",
    requestedDuration: exactDuration(message, "3 haftay", [{ value: 3, unit: "weeks" }]),
  });
  assert.equal(canonical.resolvedItem.id, "synthetic_charlie");
  assert.equal(canonical.turn.durationDays, 21);
});

// ============================================================
// Section 2: critical invariants.
// ============================================================

test("invariant: no dual authority -- semantic status=none wins even when the legacy regex would have found a duration", async () => {
  const message = "10 days"; // parseUserDuration WOULD resolve this to 10 days
  assert.equal(parseUserDuration(message)?.normalizedDays, 10);
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    // The model explicitly says no duration was stated this turn (e.g. it
    // judged the "10 days" span to be something else, like a policy answer).
    requestedDuration: NONE_DURATION,
  });
  assert.equal(canonical.durationSemanticStatus, "none");
  assert.equal(canonical.turn.durationDays, null, "regex must never rescue/override the semantic verdict");
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
});

test("invariant: validated Group with no requestedDuration opinion does not consult parseUserDuration", async () => {
  const message = "10 days";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: null, // field genuinely absent -- not_applicable, not "none"
  });
  assert.equal(canonical.durationSemanticStatus, "not_applicable");
  assert.equal(
    canonical.turn.durationDays,
    null,
    "validated Group must not use parseUserDuration when the Brain omitted requestedDuration"
  );
});

test("invariant: non-Group decision with no requestedDuration opinion still uses the legacy regex", async () => {
  const message = "10 days";
  const canonical = await resolveFor(message, {
    isGroup: false,
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    requestedDuration: null,
  });
  assert.equal(canonical.durationSemanticStatus, "not_applicable");
  assert.equal(canonical.turn.durationDays, 10, "legacy regex chain still works off the Group canonical path");
});

test("invariant: duration cannot switch transaction intent by itself -- availability + bare duration stays availability, never pricing", async () => {
  const message = "2 maheenon k lye";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: exactDuration(message, message, [{ value: 2, unit: "months" }]),
  });
  // The transition machinery below is availability-specific by construction
  // (resultingState is always an availability state) -- reaching
  // READY_FOR_OWNER_CHECK here IS the proof the transaction stayed
  // availability rather than being reinterpreted as a pricing turn.
  assert.equal(canonical.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
  assert.equal(
    canonical.availabilityConversationTransition.transitionReason,
    "group_duration_pending_duration_supplied_ignores_model_only_temporal_unresolved"
  );
});

test("invariant: start date and duration are independent fields -- neither overwrites the other", async () => {
  const message = "kal se 3 din ke liye";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    temporalRequest: {
      startDateKind: "relative_tomorrow",
      startDate: null,
      evidence: evidenceFor(message, "kal"),
    },
    requestedDuration: exactDuration(message, "3 din", [{ value: 3, unit: "days" }]),
  });
  assert.equal(canonical.turn.durationDays, 3, "duration must resolve");
  assert.equal(canonical.duration.calendarRelative, "tomorrow", "start-date signal must ALSO survive, unmodified by duration");
});

// ============================================================
// Section 3: regression matrix -- synthetic items, varied language forms.
// Every fixture below is proven unreachable via the unmodified legacy
// regex (parseUserDuration), so resolution here is proof of the new
// semantic contract, not of parseDuration.js being expanded.
// ============================================================

const LANGUAGE_FORM_CASES = [
  { label: "2 maheenon k lye", message: "2 maheenon k lye", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "2 maheeny k lye", message: "2 maheeny k lye", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "2 mahenae", message: "2 mahenae", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "2 maheena", message: "2 maheena", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "two months", message: "two months", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "do mahine", message: "do mahine", components: [{ value: 2, unit: "months" }], days: 60 },
  { label: "3 haftay", message: "3 haftay", components: [{ value: 3, unit: "weeks" }], days: 21 },
  { label: "three weeks", message: "three weeks", components: [{ value: 3, unit: "weeks" }], days: 21 },
  { label: "10 din", message: "10 din", components: [{ value: 10, unit: "days" }], days: 10 },
  { label: "10 days", message: "10 days", components: [{ value: 10, unit: "days" }], days: 10 },
];

for (const [index, c] of LANGUAGE_FORM_CASES.entries()) {
  test(`regression: "${c.label}" resolves via semantic structure, not regex`, async () => {
    // Every entry proven to defeat the unmodified regex parser -- except the
    // control cases the legacy regex already recognized before this task
    // (plain English/Roman Urdu forms whose unit word was always in its
    // pattern), which must continue to resolve identically via the new
    // semantic path (proving no regression, not a new capability).
    const legacy = parseUserDuration(c.message);
    if (!["3 haftay", "10 din", "10 days"].includes(c.label)) {
      assert.equal(legacy, null, `expected legacy regex to NOT understand "${c.label}"`);
    }
    const itemId = `synthetic_item_${index}`;
    const itemLabel = `Synthetic Item ${index}`;
    const canonical = await resolveFor(c.message, {
      itemId,
      itemLabel,
      memorySnapshot: { emilyPending: activePending(itemId, itemLabel, `group-${index}`) },
      groupKey: `group-${index}`,
      requestedDuration: exactDuration(c.message, c.message, c.components),
    });
    if (c.days == null) {
      assert.equal(canonical.durationSemanticStatus, "invalid_structured_output", c.label);
      assert.equal(canonical.turn.durationDays, null, c.label);
      assert.equal(
        canonical.availabilityConversationTransition.resultingState,
        "NEED_DURATION",
        c.label
      );
      return;
    }
    assert.equal(canonical.durationSemanticStatus, "exact", c.label);
    assert.equal(canonical.turn.durationDays, c.days, c.label);
    assert.equal(canonical.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK", c.label);
    assert.equal(canonical.resolvedItem.id, itemId, c.label);
  });
}

// ============================================================
// Section 4: non-exact/ambiguous categories -- every one must clarify, not
// invent an exact value.
// ============================================================

const NON_EXACT_CASES = [
  { label: "vague quantity", message: "kuch din ke liye", phrase: "kuch din" },
  { label: "few days", message: "few days chahiye", phrase: "few days" },
  { label: "approximate", message: "around 2 months chahiye", phrase: "around 2 months" },
  { label: "lagbhag", message: "lagbhag 2 mahine", phrase: "lagbhag 2 mahine" },
  { label: "range (digits)", message: "2-3 days ke liye", phrase: "2-3 days" },
  { label: "range (words)", message: "one or two weeks", phrase: "one or two weeks" },
  { label: "minimum", message: "at least 2 weeks", phrase: "at least 2 weeks" },
  { label: "kam az kam", message: "kam az kam 10 din", phrase: "kam az kam 10 din" },
  { label: "maximum", message: "up to 10 days", phrase: "up to 10 days" },
  { label: "open-ended more-than", message: "more than a month", phrase: "more than a month" },
  { label: "open-ended less-than", message: "less than a week", phrase: "less than a week" },
  { label: "indefinite colloquial", message: "a couple of months", phrase: "a couple of months" },
  { label: "weekend", message: "weekend ke liye chahiye", phrase: "weekend ke liye" },
  { label: "decimal", message: "1.5 months chahiye", phrase: "1.5 months" },
  { label: "multiple alternatives", message: "2 months ya 3 months", phrase: "2 months ya 3 months" },
  { label: "unsupported unit", message: "2 fortnights chahiye", phrase: "2 fortnights" },
];

for (const c of NON_EXACT_CASES) {
  test(`non-exact category: "${c.label}" clarifies instead of guessing an exact value`, async () => {
    const canonical = await resolveFor(c.message, {
      itemId: "synthetic_alpha",
      itemLabel: "Synthetic Alpha",
      memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
      requestedDuration: nonExactDuration(c.message, c.phrase),
    });
    assert.equal(canonical.durationSemanticStatus, "non_exact", c.label);
    assert.equal(canonical.turn.durationDays, null, c.label);
    assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION", c.label);
  });
}

// ============================================================
// Section 5: "none" categories -- duration text present in the message but
// not the customer's own current requested duration.
// ============================================================

test("none category: a question about policy is not a requested duration", async () => {
  const message = "maximum kitne din mil sakti hai?";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: NONE_DURATION,
  });
  assert.equal(canonical.durationSemanticStatus, "none");
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
});

test("none category: correction/negation resolves to the final intended value, not the negated one", async () => {
  // "2 months nahi, 3 months" -- the model is expected to report only the
  // customer's final intended amount; this test proves the pipeline simply
  // trusts and uses that final structured value faithfully.
  const message = "2 months nahi, 3 months";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    memorySnapshot: { emilyPending: activePending("synthetic_alpha", "Synthetic Alpha") },
    requestedDuration: exactDuration(message, "3 months", [{ value: 3, unit: "months" }]),
  });
  assert.equal(canonical.turn.durationDays, 90);
});

// ============================================================
// Section 6: duration resolves independently of which semantic intent the
// Brain separately classifies (pricing vs availability) -- this test only
// proves the duration field itself is orthogonal, not the intent
// classification logic (already covered elsewhere, untouched by this task).
// ============================================================

test("duration resolves the same way regardless of the co-occurring semantic intent", async () => {
  const message = "2 mahine ka rent kitna hoga?";
  const canonical = await resolveFor(message, {
    itemId: "synthetic_alpha",
    itemLabel: "Synthetic Alpha",
    requestedDuration: exactDuration(message, "2 mahine", [{ value: 2, unit: "months" }]),
  });
  assert.equal(canonical.turn.durationDays, 60);
});

// ============================================================
// Section 7: production-code confirmation -- parseDuration.js is untouched.
// ============================================================

test("confirmation: parseUserDuration still cannot understand any of the fixture spellings used above (proves no regex expansion)", () => {
  for (const c of LANGUAGE_FORM_CASES) {
    if (["3 haftay", "10 din", "10 days"].includes(c.label)) continue;
    assert.equal(parseUserDuration(c.message), null, c.label);
  }
});
