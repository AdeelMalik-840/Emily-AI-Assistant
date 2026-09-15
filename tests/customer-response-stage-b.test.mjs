import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { buildCustomerCommunicationPolicy } = await import(
  "../src/brain/policies/customerCommunicationPolicy.js"
);
const { buildCustomerReplyGuardCorrection } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function durationCompletion(customerReply) {
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

test("shared policy has behavioral guidance without worked availability replies", () => {
  const policy = buildCustomerCommunicationPolicy({ channel: "group" });
  assert.doesNotMatch(policy, /Style demonstration|Corolla|Civic|Stonic/i);
  assert.match(policy, /make conversational progress/i);
  assert.match(policy, /avoid translated-English word order/i);
});

test("repetition correction is actionable and identity-free", () => {
  const repetition = buildCustomerReplyGuardCorrection(
    "CONTINUATION_MATERIALLY_REPEATS_PREVIOUS_REPLY"
  );
  assert.match(repetition, /lightly rearranged the prior assistant reply/i);
  assert.match(repetition, /make genuine conversational progress/i);
  assert.doesNotMatch(repetition, /Corolla|Civic|Stonic/i);
});

// Migrated: grammar/naturalness is no longer a deterministic rejection
// reason (no regex/word-order decision logic remains in production code).
// It is now owned by the AI language-quality review/rewrite step inside
// composeCloudCanonicalCustomerReply.js, gated on the canonical policy's
// replyPolicy.linguisticGuidance -- see tests/compose-duration-ask-grammar-generic.test.mjs
// for that architecture's coverage (Tests A-F).
test("a candidate accepted by the deterministic guard is still passed through the language-quality review step, and an accepted rewrite is delivered", async () => {
  let generationCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: proves the reviewer rewrite MECHANISM itself, which is
    // unchanged. Canonical Group replies now treat the reviewer as
    // diagnostics-only (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "gaari available hai?",
    trustedFacts: { itemId: "item-1", itemLabel: "Sedan" },
    __chatCompletionsCreateForTests: async () => {
      generationCalls += 1;
      return durationCompletion("Sedan ke liye kitne din chahiye?");
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          quality: "rewrite",
          issues: ["unnatural_word_order"],
          dimensionChecks: {
            naturalWordOrder: "rewrite",
            modifierAttachment: "pass",
            spokenFluency: "pass",
            directnessAndEfficiency: "pass",
            objectiveFidelity: "pass",
            catalogDetailProportionality: "pass",
            personaConsistency: "pass",
            nativeLanguageExpression: "pass",
          },
          reply: "Sedan aapko kitne din ke liye chahiye?",
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
        }) } }],
      };
    },
  });
  assert.equal(generationCalls, 1, "the deterministic guard accepts the first candidate -- no grammar-based retry exists anymore");
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Sedan aapko kitne din ke liye chahiye?");
});

test("repetition retry succeeds only after progress correction is supplied", async () => {
  const previous = "Sedan kitne din ke liye chahiye?";
  let calls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: `Assistant: ${previous}`,
    trustedFacts: { itemId: "item-1", itemLabel: "Sedan" },
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      return durationCompletion(
        /make genuine conversational progress/i.test(prompt)
          ? "Exact availability ke liye rental period bata dein."
          : previous
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test("Group compose logs privacy-safe per-attempt diagnostics", async () => {
  const rows = [];
  const originalLog = console.log;
  console.log = (label, value) => {
    if (label === "[group_customer_reply_compose_attempt]") rows.push(value);
  };
  try {
    let calls = 0;
    const result = await composeCloudCanonicalCustomerReply({
      kind: "duration_ask",
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: "private customer text",
      trustedFacts: { itemId: "private-item-id", itemLabel: "Private Item" },
      diagnostics: {
        participantIdentityStatus: "stable",
        conversationKey: "private-conversation-key",
        durablePendingPresent: true,
      },
      __chatCompletionsCreateForTests: async () => {
        calls += 1;
        // A still-existing, unrelated deterministic rejection (the
        // structured missing-input contract) drives the two attempts here
        // -- grammar/naturalness is no longer a deterministic rejection
        // reason at all.
        return {
          choices: [{ message: { content: JSON.stringify({
            customerReply: "Private Item kitne din ke liye chahiye?",
            customerInputRequested: calls === 1 ? false : true,
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
      },
    });
    assert.equal(result.ok, true);
  } finally {
    console.log = originalLog;
  }
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attempt, 1);
  assert.equal(rows[0].rejectionReason, "DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.equal(rows[1].attempt, 2);
  assert.equal(rows[1].rejectionReason, null);
  assert.equal(rows[1].participantIdentityStatus, "stable");
  assert.equal(rows[1].durablePendingPresent, true);
  assert.match(rows[1].conversationKeyFingerprint, /^[a-f0-9]{12}$/);
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /private customer text|private-item-id|Private Item/);
  assert.doesNotMatch(serialized, /private-conversation-key/);
});
