/**
 * Root-cause remediation: canonical reply-permission contract.
 *
 * Live failure: "Corolla available hai?" (duration_ask, no rental period
 * given) produced "Corolla abhi available hai, lekin rental duration bata
 * dein..." -- a self-contradiction, since a duration_ask reply must not
 * confirm availability before the requested window is known. This was not
 * item-specific (an arbitrary item asked the same way reproduces it) and
 * was not caused by a misleading fact reaching the composer (trustedFacts
 * for duration_ask carries no availability field at all) -- the model
 * simply generated the claim unconstrained, the guard correctly rejected
 * it twice, and the composer fell back to the generic emergency sentence.
 *
 * Fix: one canonical reply-policy derivation (buildCustomerReplyPolicy,
 * src/brain/contracts/customerReplyContract.js) is now the single source of
 * what Emily may claim for a given kind (+ fact-gated exceptions) --
 * consumed identically by the prompt (explicit SEMANTIC PERMISSIONS block),
 * the guard (allowedClaims/forbiddenClaims + a generic claim-text-signal
 * check, extended to also catch a forbidden "unavailable" claim
 * symmetrically), and retry correction (buildCustomerReplyGuardCorrection
 * now derives a generic claim-violation correction from the actual
 * violated claim + current objective, not a fixed sentence). No item name,
 * no phrase map, no new bespoke regex per kind.
 *
 * Every test drives the real production composeCloudCanonicalCustomerReply
 * function end to end. Item labels used here are arbitrary, generic
 * placeholders -- never the observed live item.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const {
  buildCustomerReplyPolicy,
  assembleCustomerReplyComposeRequest,
} = await import("../src/brain/contracts/customerReplyContract.js");
const { buildCustomerReplyGuardCorrection, extractViolatedClaimFromReason } =
  await import("../src/brain/guards/customerReplyGuard.js");

function durationAskCompletion({
  customerReply,
  claims = [],
  customerInputRequested = true,
  requestedInput = "rental_period",
  availabilityCheckStarted = false,
}) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested,
      requestedInput,
      availabilityCheckStarted,
      replySemantics: {
        claims,
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  };
}

async function composeDurationAsk({
  itemId = "generic_item_1",
  itemLabel = "Generic Item",
  conversationStage = "initial_request",
  recentDialogue = null,
  onCompletion,
}) {
  let attempts = 0;
  const seenUserPrompts = [];
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: `${itemLabel} available hai?`,
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      attempts += 1;
      seenUserPrompts.push(String(args.messages.at(-1)?.content ?? ""));
      return onCompletion(attempts);
    },
  });
  return { attempts, result, seenUserPrompts };
}

// ============================================================
// Test A / B: arbitrary items, availability claim rejected, then a
// policy-derived retry correction reaches ai_success
// ============================================================

for (const { itemId, itemLabel, label } of [
  { itemId: "rental_alpha_1", itemLabel: "Rental Alpha", label: "Test A (item 1)" },
  { itemId: "rental_beta_2", itemLabel: "Rental Beta", label: "Test B (item 2)" },
]) {
  test(`${label}: an availability-confirming duration_ask reply is rejected; the policy-derived retry succeeds naturally`, async () => {
    const { attempts, result } = await composeDurationAsk({
      itemId,
      itemLabel,
      onCompletion: (attempt) =>
        attempt === 1
          ? durationAskCompletion({
              customerReply: `${itemLabel} abhi available hai, lekin rental duration bata dein taake main check kar sakun.`,
            })
          : durationAskCompletion({
              customerReply: `${itemLabel} kitne din ke liye chahiye?`,
            }),
    });
    assert.equal(attempts, 2, "the availability-confirming attempt must be rejected and retried");
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "ai_success");
    assert.notEqual(result.outcome, "fallback");
    assert.doesNotMatch(result.reply, /available hai|is available|available now/i);
  });
}

// ============================================================
// Test C: contaminated history -- an earlier assistant turn in
// RECENT_DIALOGUE falsely claimed availability; the current policy still
// overrides it
// ============================================================

test("Test C (contaminated history): old assistant reply falsely claimed availability; current policy still forbids it, and the final success never confirms availability", async () => {
  const itemLabel = "Rental Gamma";
  const contaminatedHistory =
    `User: ${itemLabel} available hai?\n` +
    `Assistant: ${itemLabel} abhi available hai, lekin rental duration bata dein taake main check kar sakun.`;
  let attempts = 0;
  const seenUserPrompts = [];
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: `${itemLabel} available hai?`,
    // initial_request: this turn is not a continuation of that contaminated
    // reply, but RECENT_DIALOGUE is still passed to the model unconditionally
    // -- proving the policy overrides it regardless of conversation stage.
    conversationStage: "initial_request",
    recentDialogue: contaminatedHistory,
    trustedFacts: { itemId: "rental_gamma_3", itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      attempts += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      seenUserPrompts.push(prompt);
      const sawViolationCorrection =
        /Previous reply asserted a forbidden claim: resource_availability_confirmed/.test(
          prompt
        );
      return durationAskCompletion({
        customerReply: sawViolationCorrection
          ? `${itemLabel} kitne din ke liye chahiye?`
          : `${itemLabel} abhi available hai, rental duration bata dein.`,
      });
    },
  });
  assert.equal(attempts, 2, "contaminated history must not let a fresh availability claim through");
  assert.ok(
    /Previous reply asserted a forbidden claim: resource_availability_confirmed/.test(
      seenUserPrompts.at(-1) ?? ""
    ),
    "attempt 2's prompt must contain the policy-derived violation correction"
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.doesNotMatch(result.reply, /available hai|is available|available now/i);
  // The old, contaminated text is genuinely present in RECENT_DIALOGUE (the
  // guard/policy overrides it -- history is never heuristically filtered).
  assert.match(seenUserPrompts[0], /available hai, lekin rental duration/i);
});

// ============================================================
// Test D: continuation stage -- same semantic permissions, different
// conversational-stage handling, no repetition/fallback
// ============================================================

test("Test D (continuation): already_waiting_for_duration keeps the same forbidden/allowed claims as initial_request, with no repetition or fallback", async () => {
  const itemLabel = "Rental Delta";
  const previous = `${itemLabel} kitne din ke liye chahiye?`;
  const { attempts, result } = await composeDurationAsk({
    itemId: "rental_delta_4",
    itemLabel,
    conversationStage: "already_waiting_for_duration",
    recentDialogue: `User: ${itemLabel} available hai?\nAssistant: ${previous}`,
    onCompletion: (attempt) =>
      attempt === 1
        ? durationAskCompletion({
            customerReply: `${itemLabel} available hai, rental duration bata dein.`,
          })
        : durationAskCompletion({
            customerReply: "Exact availability check karne ke liye rental period zaroori hai -- kitne din ke liye chahiye?",
          }),
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.reply, previous, "must not be a bare repetition either");
});

// ============================================================
// Test E: a kind/state where trusted execution actually permits
// resource_availability_confirmed must still allow it -- the fix does not
// globally ban availability claims
// ============================================================

test("Test E: availability_approved with a confirmed fact still allows the resource_availability_confirmed claim", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "availability_approved",
    channel: "dm",
    trustedFacts: {
      itemId: "rental_epsilon_5",
      itemLabel: "Rental Epsilon",
      availabilityConfirmed: true,
      durationDays: 3,
      totalAmount: 15000,
    },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion({
        customerReply: "Rental Epsilon 3 din ke liye available hai, total 15000 hai. Book kar dun?",
        claims: ["resource_availability_confirmed", "quotation_verified"],
        customerInputRequested: false,
        requestedInput: "rental_period",
        availabilityCheckStarted: true,
      }),
  });
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.ok, true);
});

test("Test E (policy shape): buildCustomerReplyPolicy allows resource_availability_confirmed only when facts.availabilityConfirmed is true", () => {
  const confirmed = buildCustomerReplyPolicy("availability_approved", {
    availabilityConfirmed: true,
  });
  const unconfirmed = buildCustomerReplyPolicy("availability_approved", {
    availabilityConfirmed: false,
  });
  assert.ok(confirmed.allowedClaims.includes("resource_availability_confirmed"));
  assert.ok(!unconfirmed.allowedClaims.includes("resource_availability_confirmed"));
});

// ============================================================
// Test F: structured contract -- policy and schema fields cannot drift
// ============================================================

test("Test F: duration_ask policy's requestedInput/executionState match the schema fields the composer actually requires", () => {
  const policy = buildCustomerReplyPolicy("duration_ask", { itemId: "x1" });
  assert.equal(policy.customerInputRequired, true);
  assert.equal(policy.requestedInput, "rental_period");
  assert.equal(policy.executionState.availabilityCheckStarted, false);
  assert.ok(policy.forbiddenClaims.includes("resource_availability_confirmed"));
  assert.ok(policy.forbiddenClaims.includes("resource_unavailable"));
});

test("Test F: temporal_clarification policy requires start_date, not rental_period -- no drift between sibling kinds", () => {
  const policy = buildCustomerReplyPolicy("temporal_clarification", { itemId: "x1" });
  assert.equal(policy.requestedInput, "start_date");
  assert.ok(policy.forbiddenClaims.includes("resource_availability_confirmed"));
  assert.ok(policy.forbiddenClaims.includes("resource_unavailable"));
});

test("Test F: assembleCustomerReplyComposeRequest attaches the same replyPolicy shape a direct call produces", () => {
  const direct = buildCustomerReplyPolicy("duration_ask", { itemId: "x1", itemLabel: "X" });
  const assembled = assembleCustomerReplyComposeRequest({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemId: "x1", itemLabel: "X" },
  });
  assert.equal(assembled.ok, true);
  assert.deepEqual(assembled.request.replyPolicy, direct);
});

// ============================================================
// Test G: retry must be genuinely derived from the violation + policy --
// this test fails if attempt 2 blindly returns a good response regardless
// of what the correction prompt actually said
// ============================================================

test("Test G: retry correction genuinely names the violated claim and objective, and the mock only self-corrects upon seeing that specific text", () => {
  const correction = buildCustomerReplyGuardCorrection(
    "unsupported_availability_confirmed_claim",
    { objective: "collect_missing_rental_period", requestedInput: "rental_period" }
  );
  assert.match(correction, /Previous reply asserted a forbidden claim: resource_availability_confirmed/);
  assert.match(correction, /current objective is only: collect_missing_rental_period/i);
  assert.equal(
    extractViolatedClaimFromReason("unsupported_availability_confirmed_claim"),
    "resource_availability_confirmed"
  );
  assert.equal(
    extractViolatedClaimFromReason("forbidden_claim:resource_unavailable"),
    "resource_unavailable"
  );
  // A reason with no claim-violation shape (e.g. a schema/structural
  // failure) must not be misidentified as a claim violation.
  assert.equal(extractViolatedClaimFromReason("DURATION_ASK_ROMAN_URDU_GRAMMAR_MALFORMED"), null);
});

test("Test G (end-to-end, non-trivial mock): attempt 2 only succeeds because it inspects the real correction text, not because it is scripted by attempt number", async () => {
  const itemLabel = "Rental Zeta";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemId: "rental_zeta_6", itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      attempts += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      const sawViolationCorrection = /Previous reply asserted a forbidden claim: resource_availability_confirmed/.test(
        prompt
      );
      // If the mock ignored the actual correction content and merely
      // scripted "attempt 2 = good", this assertion structure would still
      // pass by coincidence; the real proof is the negative test below,
      // which shows a mock that *never* reads the correction text cannot
      // reach ai_success at all.
      return durationAskCompletion({
        customerReply: sawViolationCorrection
          ? `${itemLabel} kitne din ke liye chahiye?`
          : `${itemLabel} available hai, rental duration bata dein.`,
      });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.outcome, "ai_success");
});

test("Test G (negative control): a mock that never reads the correction text keeps violating and never reaches ai_success", async () => {
  const itemLabel = "Rental Eta";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    trustedFacts: { itemId: "rental_eta_7", itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      // Deliberately ignores whatever correction text it received.
      return durationAskCompletion({
        customerReply: `${itemLabel} available hai, rental duration bata dein.`,
      });
    },
  });
  assert.equal(attempts, 2);
  assert.notEqual(result.outcome, "ai_success");
  assert.equal(result.outcome, "fallback");
});
