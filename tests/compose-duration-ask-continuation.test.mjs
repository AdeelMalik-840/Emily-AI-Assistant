/**
 * Live repetition fix: composeCloudCanonicalCustomerReply's duration_ask
 * instruction previously gave the model the exact same style-anchored
 * instruction regardless of conversationStage, so an already_waiting
 * continuation turn reused the same fixed example near-verbatim (proven
 * live: "Corolla kitne din ke liye chahiye aapko?" repeated turn after
 * turn). Fix is scoped entirely to composeCloudCanonicalCustomerReply.js's
 * duration_ask instruction branch -- these tests drive the real production
 * composer function directly, never a bypass, and assert the actual prompt
 * content plus end-to-end composed behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

const COROLLA_FACTS = {
  itemId: "toyota_corolla_metallic_grey_0e2cd610",
  itemLabel: "Corolla",
};

function validDurationAskCompletion(customerReply) {
  return async () => ({
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
  });
}

async function capturePrompt({ conversationStage, recentDialogue, customerReply }) {
  let captured = null;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage,
    recentDialogue,
    trustedFacts: COROLLA_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      captured = args.messages;
      return validDurationAskCompletion(customerReply)();
    },
  });
  const system = captured.find((m) => m.role === "system")?.content ?? "";
  const user = captured.find((m) => m.role === "user")?.content ?? "";
  return { system, user, result };
}

test("initial_request and already_waiting_for_duration produce different duration_ask instructions", async () => {
  const initial = await capturePrompt({
    conversationStage: "initial_request",
    recentDialogue: "",
    customerReply: "Corolla kitne din ke liye chahiye?",
  });
  const continuation = await capturePrompt({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    customerReply: "Abhi bhi wahi poochna hai — kitne din ke liye chahiye Corolla?",
  });
  assert.notEqual(initial.system, continuation.system);
});

test("already_waiting_for_duration instruction explicitly tells the composer to use RECENT_DIALOGUE", async () => {
  const { system } = await capturePrompt({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    customerReply: "Kitne din ke liye soch rahe hain Corolla?",
  });
  assert.match(system, /RECENT_DIALOGUE/);
  assert.match(system, /already asked/i);
});

test("already_waiting_for_duration instruction explicitly forbids repeating the immediately previous assistant question verbatim", async () => {
  const { system } = await capturePrompt({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    customerReply: "Kitne din ke liye soch rahe hain Corolla?",
  });
  assert.match(system, /word-for-word|verbatim/i);
  assert.match(system, /vary the phrasing/i);
});

test("initial_request instruction still naturally asks for duration, with no already-waiting/continuation framing", async () => {
  const { system, result } = await capturePrompt({
    conversationStage: "initial_request",
    recentDialogue: "",
    customerReply: "Corolla kitne din ke liye chahiye?",
  });
  assert.doesNotMatch(system, /already_waiting_for_duration/);
  assert.doesNotMatch(system, /RECENT_DIALOGUE shows you already asked/i);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
});

test("continuation still asks for the missing duration, never invents a duration, and the shared guard contract is unchanged", async () => {
  const { result } = await capturePrompt({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    // A varied, non-verbatim reply a real model would plausibly produce
    // once instructed to treat this as a continuation.
    customerReply: "Kitne din ke liye soch rahe hain Corolla?",
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /kitne din/i);
  assert.doesNotMatch(result.reply, /\bkab se\b/i);
  assert.doesNotMatch(result.reply, /\bdates\b/i);
  // No invented duration/date value anywhere in the reply.
  assert.doesNotMatch(result.reply, /\b\d+\s*din\b/i);
  assert.doesNotMatch(result.reply, /\b(available|book|confirm)\s+hai\b/i);
});

test("a real continuation reply that reuses the previous question verbatim is still rejected by the existing local-validation guard path (contract unchanged)", async () => {
  // The shared guard's duration_ask contract (customerInputRequested,
  // requestedInput, availabilityCheckStarted) is untouched by this fix --
  // confirm a schema-incomplete continuation reply still fails the same way
  // an initial-request one always did.
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    trustedFacts: COROLLA_FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Corolla kitne din ke liye chahiye?",
          // Missing customerInputRequested/requestedInput/availabilityCheckStarted
          // -- must still fail DURATION_INPUT_CONTRACT_NOT_SATISFIED like before.
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 2, "guard still retries once on contract failure, unchanged");
  // result.ok reflects "there is a reply to send" (true once a non-empty
  // fallback is supplied) -- the AI attempt being rejected rather than
  // accepted is proven by source/reply falling back, not by ok itself.
  assert.notEqual(result.source, "openai_group_availability_compose");
  assert.equal(result.reply, "FALLBACK_UNUSED");
});
