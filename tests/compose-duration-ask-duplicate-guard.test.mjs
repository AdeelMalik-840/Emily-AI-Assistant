/**
 * Second live repetition fix: even with the already_waiting_for_duration
 * continuation instruction in place, a real OpenAI call could still return
 * an exact duplicate of Emily's immediately previous reply, and nothing
 * validated that -- confirmed live (Stonic "kitne din ke liye chahiye
 * aapko?" repeated verbatim) and confirmed empirically pre-fix (an
 * exact-duplicate, schema-valid reply was accepted on attempt 1, no retry).
 *
 * composeCloudCanonicalCustomerReply.js now extracts the immediately
 * previous assistant reply from recentDialogue (via the existing
 * extractRecentAssistantTextsFromPromptBlock utility -- the real
 * "Assistant: ..." / "User: ..." label format getRecentConversationForPrompt
 * actually produces, not an invented one) and rejects an exact normalized
 * duplicate through the existing extraReject/retry mechanism. These tests
 * drive the real production composer function directly, never a bypass.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

const STONIC_FACTS = { itemId: "kia_stonic_white_1a2b3c4d", itemLabel: "Kia Stonic" };

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

// The exact production dialogue label format (getRecentConversationForPrompt
// in src/services/conversationStore.js), never an invented one.
function recentDialogueBlock(customerLine, assistantLine) {
  return `User: ${customerLine}\nAssistant: ${assistantLine}`;
}

test("exact duplicate of the immediately previous assistant reply is rejected on attempt 1 and retried", async () => {
  const previousReply = "Kia Stonic kitne din ke liye chahiye aapko?";
  let attempts = 0;
  const seenCompletions = [];
  await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previousReply),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      seenCompletions.push(attempts);
      // Simulate the real live failure: OpenAI returns the exact same
      // sentence again, fully schema-valid.
      return schemaValidDurationAskCompletion(previousReply);
    },
  });
  assert.equal(attempts, 2, "attempt 1 must be rejected and retried, not accepted");
});

test("retried attempt with a genuinely different continuation is accepted", async () => {
  const previousReply = "Kia Stonic kitne din ke liye chahiye aapko?";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previousReply),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      if (attempts === 1) {
        return schemaValidDurationAskCompletion(previousReply);
      }
      // A real model self-correcting after the guard's rejection feedback.
      return schemaValidDurationAskCompletion(
        "Abhi bhi Stonic kitne din ke liye chahiye, bata dein?"
      );
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_group_availability_compose");
  assert.equal(result.reply, "Abhi bhi Stonic kitne din ke liye chahiye, bata dein?");
});

test("both attempts returning the exact duplicate exhausts retries and falls back to the existing emergency fallback, never the duplicate", async () => {
  const previousReply = "Kia Stonic kitne din ke liye chahiye aapko?";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previousReply),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(previousReply);
    },
  });
  assert.equal(attempts, 2);
  assert.notEqual(result.reply, previousReply);
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.notEqual(result.source, "openai_group_availability_compose");
});

test("initial_request is not subject to the continuation duplicate rule", async () => {
  const sameTextAsRecentDialogue = "Corolla kitne din ke liye chahiye?";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    conversationStage: "initial_request",
    // Even if recentDialogue happens to contain this exact text for some
    // unrelated reason, initial_request must never be duplicate-checked.
    recentDialogue: recentDialogueBlock("Corolla available hai?", sameTextAsRecentDialogue),
    trustedFacts: { itemId: "toyota_corolla_metallic_grey_0e2cd610", itemLabel: "Corolla" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(sameTextAsRecentDialogue);
    },
  });
  assert.equal(attempts, 1, "initial_request must accept on the first attempt");
  assert.equal(result.ok, true);
  assert.equal(result.reply, sameTextAsRecentDialogue);
});

test("a different valid duration question asking for the same missing information is not rejected merely because the topic repeats", async () => {
  const previousReply = "Kia Stonic kitne din ke liye chahiye aapko?";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previousReply),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      // Same missing information (still asking for duration/dates), but not
      // the same sentence -- must be accepted, not treated as a duplicate
      // just because the underlying missing field is unchanged.
      return schemaValidDurationAskCompletion("Kitne din ke liye dekh rahe hain?");
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Kitne din ke liye dekh rahe hain?");
});

test("schema, grounding, and internal-disclosure guards remain unchanged by the duplicate check", async () => {
  // A continuation reply that is NOT a duplicate but IS missing the
  // required duration-ask schema fields must still fail
  // DURATION_INPUT_CONTRACT_NOT_SATISFIED exactly as before.
  let attempts = 0;
  const schemaResult = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock(
      "Stonic available hai?",
      "Kia Stonic kitne din ke liye chahiye aapko?"
    ),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Stonic ke liye kitne din chahiye?",
          // Missing customerInputRequested/requestedInput/availabilityCheckStarted.
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 2, "unrelated schema failure still retries once, unchanged");
  assert.notEqual(schemaResult.source, "openai_group_availability_compose");

  // A non-duplicate reply that leaks internal process language must still
  // fail INTERNAL_PROCESS_DISCLOSED exactly as before.
  let internalAttempts = 0;
  const internalResult = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock(
      "Stonic available hai?",
      "Kia Stonic kitne din ke liye chahiye aapko?"
    ),
    trustedFacts: STONIC_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      internalAttempts += 1;
      return schemaValidDurationAskCompletion(
        "Owner se confirm kar ke Stonic ke din batata hun."
      );
    },
  });
  assert.equal(internalAttempts, 2, "internal-disclosure rejection still retries once, unchanged");
  assert.notEqual(internalResult.source, "openai_group_availability_compose");
});
