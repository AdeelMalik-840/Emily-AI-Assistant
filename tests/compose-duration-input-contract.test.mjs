/**
 * Live failure: duration_ask, conversationStage=initial_request, both real
 * OpenAI attempts rejected DURATION_INPUT_CONTRACT_NOT_SATISFIED, falling
 * back to the generic emergency sentence. Forensic audit proved two things
 * from code, not inference: (1) the duration_ask prompt told the model it
 * could ask about "rental period or dates", which can legitimately lead a
 * model to classify its own reply as requestedInput="start_date" -- a
 * schema-legal but contract-rejected value for this kind (proven by the
 * repo's own pre-existing "Compose-D2... (wrong for this kind)" test in
 * tests/availability-temporal-unresolved-safety.test.mjs); (2) the retry
 * correction for this exact reason gave the model no information about
 * which structured field/value was wrong.
 *
 * Fix is scoped to exactly two files: the duration_ask prompt wording in
 * composeCloudCanonicalCustomerReply.js (customer-facing wording may still
 * naturally mention dates; the structured requestedInput field must always
 * stay "rental_period" for this kind), and a new dedicated correction
 * branch in customerReplyGuard.js for DURATION_INPUT_CONTRACT_NOT_SATISFIED
 * (kept correct for temporal_clarification's sibling case too, since the
 * two kinds share this same reason code). No fixed sentence, no catalog
 * item, no phrase map, no new regex, no validator change.
 *
 * Every behavioral test drives the real production
 * composeCloudCanonicalCustomerReply function end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { buildCustomerReplyGuardCorrection } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

function durationInputCompletion({
  customerReply,
  customerInputRequested = true,
  requestedInput,
  availabilityCheckStarted = false,
}) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested,
      requestedInput,
      availabilityCheckStarted,
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  };
}

async function composeDurationAsk({ conversationStage, recentDialogue, __chatCompletionsCreateForTests, itemId = "generic_item_1", itemLabel = "Generic Item" }) {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests,
  });
  return result;
}

async function capturedSystemPrompt(conversationStage) {
  let captured = "";
  await composeDurationAsk({
    conversationStage,
    recentDialogue: conversationStage === "already_waiting_for_duration"
      ? "User: Generic Item available hai?\nAssistant: Generic Item kitne din ke liye chahiye?"
      : null,
    __chatCompletionsCreateForTests: async ({ messages }) => {
      captured = messages.find((m) => m.role === "system")?.content ?? "";
      return durationInputCompletion({
        customerReply: "Generic Item kitne din ke liye chahiye?",
        requestedInput: "rental_period",
      });
    },
  });
  return captured;
}

// ============================================================
// 1. duration_ask prompt no longer semantically conflicts with
// requestedInput="rental_period"
// ============================================================

test("duration_ask (initial_request) prompt no longer invites requestedInput=start_date, and does not teach rental_period as customer vocabulary", async () => {
  const system = await capturedSystemPrompt("initial_request");
  assert.doesNotMatch(system, /rental period or dates|duration or dates/i);
  assert.doesNotMatch(system, /requestedInput=rental_period/);
  assert.doesNotMatch(system, /collect_missing_rental_period|rental_duration|for_period|usage\/rental period/);
  assert.match(system, /Do not set structured requestedInput to start_date/);
  assert.match(system, /duration of use|without inventing a unit/i);
});

test("duration_ask (already_waiting_for_duration) prompt no longer invites requestedInput=start_date, and does not teach rental_period as customer vocabulary", async () => {
  const system = await capturedSystemPrompt("already_waiting_for_duration");
  assert.doesNotMatch(system, /rental period or dates|duration or dates/i);
  assert.doesNotMatch(system, /requestedInput=rental_period/);
  assert.match(system, /Do not set structured requestedInput to start_date/);
});

test("duration_ask prompt no longer treats dates as interchangeable with rental duration", async () => {
  const system = await capturedSystemPrompt("initial_request");
  assert.doesNotMatch(system, /day count and specific dates/i);
  assert.doesNotMatch(system, /specific dates are both/i);
  assert.match(system, /FROZEN_REPLY_MEANING/);
  assert.match(system, /Do not ask when it starts/);
});

// ============================================================
// 2. first attempt with requestedInput="start_date" is rejected
// ============================================================

test("a duration_ask reply with requestedInput=start_date is rejected on attempt 1, even though it is schema-legal", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "initial_request",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return durationInputCompletion({
        customerReply: "Generic Item kis date se chahiye?",
        requestedInput: "start_date",
      });
    },
  });
  assert.equal(attempts, 2, "attempt 1 must be rejected and retried, not accepted");
  assert.notEqual(result.source, "openai_group_availability_compose");
  assert.equal(result.reason, "DURATION_INPUT_CONTRACT_NOT_SATISFIED");
});

// ============================================================
// 3. retry prompt explicitly contains the three required structured values
// ============================================================

test("retry correction for DURATION_INPUT_CONTRACT_NOT_SATISFIED explicitly names all three required fields/values", () => {
  const correction = buildCustomerReplyGuardCorrection("DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.match(correction, /customerInputRequested must be true/);
  assert.match(correction, /requestedInput must be exactly "rental_period"/);
  assert.match(correction, /availabilityCheckStarted must be false/);
  assert.match(correction, /Do not turn this into a start-date question/);
  assert.doesNotMatch(correction, /even when you naturally phrase.*dates/i);
});

test("retry correction for this reason contains no catalog item, no fixed customer sentence, no phrase map", () => {
  const correction = buildCustomerReplyGuardCorrection("DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.doesNotMatch(correction, /Corolla|Civic|Stonic/i);
  assert.doesNotMatch(correction, /"kitne din|"kis date/);
});

test("retry correction still gives temporal_clarification's sibling case (start_date) correct, unchanged guidance", () => {
  const correction = buildCustomerReplyGuardCorrection("DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.match(correction, /use "start_date" only when the missing input is a start date/i);
});

// ============================================================
// 4 & 5. the mock corrects attempt 2 only when the actionable guidance is
// present, and the corrected attempt returns ai_success, not fallback
// ============================================================

test("real retry: an attempt-2 mock that only self-corrects when it sees the actionable correction text reaches ai_success", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "initial_request",
    __chatCompletionsCreateForTests: async ({ messages }) => {
      attempts += 1;
      const prompt = String(messages.at(-1)?.content ?? "");
      const sawActionableGuidance =
        /requestedInput must be exactly "rental_period"/.test(prompt);
      return durationInputCompletion({
        customerReply: sawActionableGuidance
          ? "Generic Item kitne din ke liye chahiye?"
          : "Generic Item kis date se chahiye?",
        requestedInput: sawActionableGuidance ? "rental_period" : "start_date",
      });
    },
  });
  assert.equal(attempts, 2, "attempt 1 has no correction text yet and must still be rejected");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.outcome, "fallback");
  assert.equal(result.source, "openai_group_availability_compose");
  assert.equal(result.reply, "Generic Item kitne din ke liye chahiye?");
});

test("real retry: if the model never corrects requestedInput, both attempts fail and outcome is fallback, never ai_success", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "initial_request",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return durationInputCompletion({
        customerReply: "Generic Item kis date se chahiye?",
        requestedInput: "start_date",
      });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.outcome, "fallback");
  assert.notEqual(result.outcome, "ai_success");
  assert.equal(result.reply, "FALLBACK_UNUSED");
});

// ============================================================
// 6. existing temporal_clarification behavior remains unchanged
// ============================================================

test("temporal_clarification still requires requestedInput=start_date and rejects rental_period (unchanged by this fix)", async () => {
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "temporal_clarification",
    channel: "group",
    trustedFacts: { itemId: "generic_item_1", itemLabel: "Generic Item", clarifyStartDate: true },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return durationInputCompletion({
        customerReply: "Generic Item kitne din ke liye chahiye?",
        requestedInput: "rental_period",
      });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.reason, "DURATION_INPUT_CONTRACT_NOT_SATISFIED");
  assert.notEqual(result.outcome, "ai_success");
});

test("temporal_clarification with the correct requestedInput=start_date is still accepted (unchanged by this fix)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "temporal_clarification",
    channel: "group",
    trustedFacts: { itemId: "generic_item_1", itemLabel: "Generic Item", clarifyStartDate: true },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () =>
      durationInputCompletion({
        customerReply: "Generic Item kis date se chahiye?",
        requestedInput: "start_date",
      }),
  });
  assert.equal(result.outcome, "ai_success");
});
