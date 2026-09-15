/**
 * Root-cause remediation Stage A completion: assembleCustomerReplyComposeRequest
 * (src/brain/contracts/customerReplyContract.js) is now the single boundary
 * through which composeCloudCanonicalCustomerReply receives kind, channel,
 * semanticIntent, conversationStage, customerMessage, trustedFacts,
 * recentDialogue, and fallback policy -- no field is read a second time
 * from raw caller params after assembly succeeds.
 *
 * This file tests the CONTRACT itself (not one more grammar/sentence
 * fixture): conversationStage normalization against a closed set,
 * reconciliation against recentDialogue (a claimed continuation with no
 * real prior assistant turn must never silently survive), channel
 * explicitness, and the ai_success/fallback/failed outcome split. Contract
 * shape is unit-tested directly (assembleCustomerReplyComposeRequest is a
 * pure function -- there is nothing to "bypass" by calling it directly to
 * assert its own output shape); every BEHAVIORAL assertion drives the real
 * composeCloudCanonicalCustomerReply end to end, never a reimplementation.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  assembleCustomerReplyComposeRequest,
  normalizeConversationStageForKind,
  reconcileConversationStageWithRecentDialogue,
  CUSTOMER_REPLY_COMPOSE_OUTCOMES,
} = await import("../src/brain/contracts/customerReplyContract.js");
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function schemaValidDurationAskCompletion(customerReply) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested: true,
      requestedInput: "rental_period",
      availabilityCheckStarted: false,
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  };
}

// ============================================================
// Section A: conversationStage normalization (closed set for duration_ask)
// ============================================================

test("normalizeConversationStageForKind: recognized duration_ask stages pass through unchanged", () => {
  assert.equal(normalizeConversationStageForKind("duration_ask", "initial_request"), "initial_request");
  assert.equal(normalizeConversationStageForKind("duration_ask", "already_waiting_for_duration"), "already_waiting_for_duration");
});

test("normalizeConversationStageForKind: an unrelated/garbage stage for duration_ask is never coerced into a real stage", () => {
  assert.equal(normalizeConversationStageForKind("duration_ask", "banana_stage_not_real"), null);
  assert.equal(normalizeConversationStageForKind("duration_ask", "already_waiting_for_duration_typo"), null);
});

test("normalizeConversationStageForKind: missing/empty stage normalizes to null, not a guessed default", () => {
  assert.equal(normalizeConversationStageForKind("duration_ask", undefined), null);
  assert.equal(normalizeConversationStageForKind("duration_ask", null), null);
  assert.equal(normalizeConversationStageForKind("duration_ask", "   "), null);
});

test("normalizeConversationStageForKind: kinds with no restricted stage set pass any trimmed string through (informational-only usage unaffected)", () => {
  assert.equal(normalizeConversationStageForKind("temporal_clarification", "anything_here"), "anything_here");
});

// ============================================================
// Section B: reconciliation against recentDialogue -- a claimed
// continuation with no real prior assistant turn must not survive
// ============================================================

test("reconcileConversationStageWithRecentDialogue: already_waiting_for_duration WITH a real prior Assistant turn survives", () => {
  const recentDialogue = "User: Item available hai?\nAssistant: Item kitne din ke liye chahiye?";
  assert.equal(
    reconcileConversationStageWithRecentDialogue("duration_ask", "already_waiting_for_duration", recentDialogue),
    "already_waiting_for_duration"
  );
});

test("reconcileConversationStageWithRecentDialogue: already_waiting_for_duration with NO Assistant turn in recentDialogue is downgraded to null", () => {
  assert.equal(
    reconcileConversationStageWithRecentDialogue("duration_ask", "already_waiting_for_duration", "User: Item available hai?"),
    null
  );
  assert.equal(
    reconcileConversationStageWithRecentDialogue("duration_ask", "already_waiting_for_duration", null),
    null
  );
  assert.equal(
    reconcileConversationStageWithRecentDialogue("duration_ask", "already_waiting_for_duration", ""),
    null
  );
});

test("reconcileConversationStageWithRecentDialogue: a wrong/invented dialogue-label convention (not the real User:/Assistant: format) is treated the same as no history at all", () => {
  // Exactly the class of bug this reconciliation exists to catch: a caller
  // that invents its own "Customer:"/"Emily:" convention instead of the
  // real production format must never be silently treated as a genuine
  // continuation just because SOME text was present.
  assert.equal(
    reconcileConversationStageWithRecentDialogue(
      "duration_ask",
      "already_waiting_for_duration",
      "Customer: Item available hai?\nEmily: Item kitne din ke liye chahiye?"
    ),
    null
  );
});

test("reconcileConversationStageWithRecentDialogue: initial_request is never touched by reconciliation (only already_waiting_for_duration is conditional on evidence)", () => {
  assert.equal(
    reconcileConversationStageWithRecentDialogue("duration_ask", "initial_request", null),
    "initial_request"
  );
});

// ============================================================
// Section C: end-to-end proof through the real composer -- a malformed
// recentDialogue shape cannot silently activate continuation behavior
// ============================================================

async function composeDurationAsk({ conversationStage, recentDialogue, customerReply, itemId = "generic_item_1", itemLabel = "Generic Item" }) {
  let attempts = 0;
  const seenSystemPrompts = [];
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async ({ messages }) => {
      attempts += 1;
      seenSystemPrompts.push(messages.find((m) => m.role === "system")?.content ?? "");
      return schemaValidDurationAskCompletion(customerReply);
    },
  });
  return { attempts, result, seenSystemPrompts };
}

test("end-to-end: already_waiting_for_duration claimed with NO prior assistant turn in recentDialogue never gets the continuation instruction, and an exact-repeat-looking reply is accepted on attempt 1 (there is nothing real to have repeated)", async () => {
  const { attempts, result, seenSystemPrompts } = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Generic Item available hai?", // no Assistant: line at all
    customerReply: "Generic Item kitne din ke liye chahiye?",
  });
  assert.equal(attempts, 1, "with no real prior assistant turn, this is correctly treated as a fresh ask, not a continuation to compare against");
  assert.equal(result.ok, true);
  assert.doesNotMatch(seenSystemPrompts[0], /already_waiting_for_duration/, "the continuation-specific instruction must not appear when the claimed stage was downgraded");
});

test("end-to-end: already_waiting_for_duration WITH a real prior assistant turn does get the continuation instruction, and an exact repeat IS rejected", async () => {
  const previous = "Generic Item kitne din ke liye chahiye?";
  const { attempts, seenSystemPrompts } = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: `User: Generic Item available hai?\nAssistant: ${previous}`,
    customerReply: previous,
  });
  assert.equal(attempts, 2, "a genuine continuation with an exact repeat must still be rejected and retried");
  assert.match(seenSystemPrompts[0], /already_waiting_for_duration/, "the continuation instruction must appear when the stage is backed by real evidence");
});

test("end-to-end: an unrecognized conversationStage value for duration_ask behaves exactly like initial_request, not a crash or a guessed continuation", async () => {
  const { attempts, result } = await composeDurationAsk({
    conversationStage: "some_future_stage_this_composer_has_never_heard_of",
    recentDialogue: null,
    customerReply: "Generic Item kitne din ke liye chahiye?",
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
});

// ============================================================
// Section D: channel explicitness survives assembly
// ============================================================

test("assembleCustomerReplyComposeRequest: explicit group channel survives assembly with channelExplicit=true", () => {
  const assembled = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemId: "x1", itemLabel: "X" },
  });
  assert.equal(assembled.ok, true);
  assert.equal(assembled.request.channel, "group");
  assert.equal(assembled.request.channelExplicit, true);
});

test("assembleCustomerReplyComposeRequest: explicit dm channel survives assembly with channelExplicit=true", () => {
  const assembled = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    channel: "dm",
    trustedFacts: { itemId: "x1", itemLabel: "X" },
  });
  assert.equal(assembled.ok, true);
  assert.equal(assembled.request.channel, "dm");
  assert.equal(assembled.request.channelExplicit, true);
});

test("assembleCustomerReplyComposeRequest: an omitted channel still defaults to dm (backward compatible) but is distinguishably NOT explicit", () => {
  const assembled = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    trustedFacts: { itemId: "x1", itemLabel: "X" },
  });
  assert.equal(assembled.ok, true);
  assert.equal(assembled.request.channel, "dm");
  assert.equal(assembled.request.channelExplicit, false);
});

// ============================================================
// Section E: fallback outcome remains distinct from AI success
// ============================================================

test("outcome: real AI success is ai_success, never fallback", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemId: "x1", itemLabel: "X" },
    fallbackReply: "FALLBACK_TEXT",
    __chatCompletionsCreateForTests: async () =>
      schemaValidDurationAskCompletion("X kitne din ke liye chahiye?"),
  });
  assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS);
  assert.notEqual(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK);
});

test("outcome: an invalid compose request (unsupported kind) with a non-empty fallbackReply is fallback, not failed", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "not_a_real_kind",
    channel: "group",
    fallbackReply: "FALLBACK_TEXT",
  });
  assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK);
  assert.equal(result.reply, "FALLBACK_TEXT");
});

test("outcome: an invalid compose request with NO fallbackReply is failed, not fallback", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "not_a_real_kind",
    channel: "group",
  });
  assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED);
  assert.equal(result.reply, "");
});

test("outcome: both attempts rejected exhausts to fallback, and outcome says so explicitly (not inferred from ok/reply alone)", async () => {
  const previous = "X kitne din ke liye chahiye?";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: `User: X available hai?\nAssistant: ${previous}`,
    trustedFacts: { itemId: "x1", itemLabel: "X" },
    fallbackReply: "FALLBACK_TEXT",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(previous); // repeats every attempt
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true, "ok is true because a non-empty fallback WAS sent -- this is exactly why outcome, not ok, is the authoritative signal");
  assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK);
  assert.equal(result.reply, "FALLBACK_TEXT");
});

// ============================================================
// Section F: production-like request and a minimal test request produce
// the same canonical shape
// ============================================================

test("assembleCustomerReplyComposeRequest: a rich production-shaped payload and a minimal test payload assemble to the same set of canonical fields", () => {
  const productionShaped = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Item available hai?\nAssistant: Item kitne din ke liye chahiye?",
    trustedFacts: {
      itemId: "catalog_item_1",
      itemLabel: "Item",
      durationDays: null,
      verifiedAlternatives: [],
      verifiedAlternativesCount: 0,
      dailyRate: 5000,
    },
    fallbackReply: "Emergency fallback text.",
  });
  const minimalTestShaped = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    trustedFacts: { itemId: "x1" },
  });
  assert.equal(productionShaped.ok, true);
  assert.equal(minimalTestShaped.ok, true);
  assert.deepEqual(
    Object.keys(productionShaped.request).sort(),
    Object.keys(minimalTestShaped.request).sort()
  );
});

// ============================================================
// Section G: the composer is actually wired through the real assembler
// (not merely trusted to be) -- an invalid kind is rejected the same way
// the assembler itself rejects it, proving the wiring, not just the intent
// ============================================================

test("composeCloudCanonicalCustomerReply routes kind/channel/trustedFacts through the real assembler: an unsupported kind is rejected with the assembler's own error text", async () => {
  const direct = assembleCustomerReplyComposeRequest({ kind: "not_a_real_kind" });
  const result = await composeCloudCanonicalCustomerReply({ kind: "not_a_real_kind" });
  assert.equal(direct.ok, false);
  assert.equal(result.source, "cloud_canonical_compose_invalid_request");
  assert.equal(result.reason, direct.errors.join("; "));
});

test("composeCloudCanonicalCustomerReply routes trustedFacts through the real assembler: duration_ask with no itemId is rejected with the assembler's own error text", async () => {
  const direct = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    trustedFacts: { itemLabel: "Item with no id" },
  });
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemLabel: "Item with no id" },
  });
  assert.equal(direct.ok, false);
  assert.equal(result.source, "cloud_canonical_compose_invalid_request");
  assert.equal(result.reason, direct.errors.join("; "));
});
