/**
 * Root cause (this round): the live reply
 * "Toyota Corolla (Metallic Grey) chahiye? Aap ko kitne din chahiye?" is not
 * a grammar defect (Roman-Urdu word order was fine) -- it is a
 * conversational-OBJECTIVE defect: the item was already trusted/resolved,
 * yet the composer re-confirmed it with its own question before asking for
 * the one actually-missing input (rental period), producing two questions
 * where exactly one was needed.
 *
 * Forensic findings that drove this fix (see task return for full detail):
 *  - the duration_ask initial_request prompt instruction literally said
 *    "Lead with the item, then ask for that rental period" -- ambiguous
 *    enough to be satisfied by asking about the item as its own question --
 *    now replaced with generic semantic guidance never encoding a fixed
 *    sentence.
 *  - buildCustomerReplyPolicy (customerReplyContract.js) had no field at all
 *    distinguishing ALREADY-KNOWN information (the resolved item) from
 *    STILL-MISSING information (rental_period) -- neither the composer nor
 *    the language-quality reviewer had any explicit basis to judge
 *    "re-asking about the item is redundant." A new interactionGuidance
 *    field on the canonical replyPolicy now carries this generically:
 *    knownInformation / missingInformation / askOnlyForMissingInformation /
 *    doNotReconfirmKnownInformation / avoidRedundantQuestions / responseMode.
 *  - the language-quality reviewer's rubric only asked about naturalness/
 *    grammar -- it was never told to check redundancy, re-confirmation of
 *    known facts, or focus on the single requested input. A bad-but-
 *    grammatical two-question reply could legitimately receive quality=pass.
 *    The reviewer now also receives interactionGuidance and is explicitly
 *    asked to judge objective fidelity, with new closed issue categories
 *    (reasks_known_information, redundant_question, misses_requested_input,
 *    unnecessary_restatement, overcomplicated_for_objective) -- self-reported
 *    AI judgments, never lexical/regex matches in production code.
 *
 * Every fixture below is a deliberately generic, non-production item label
 * (Item Alpha / Product Beta / Service Gamma) -- interactionGuidance is
 * derived only from trusted state (requestedInput, facts.itemId), never an
 * item/group name, so any future item/group gets the same behavior
 * automatically.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function reviewCompletion(quality, reply, issues = []) {
  const dimensionChecks = {
    naturalWordOrder: "pass",
    modifierAttachment: "pass",
    spokenFluency: "pass",
    directnessAndEfficiency: quality === "rewrite" ? "rewrite" : "pass",
    objectiveFidelity: quality === "rewrite" ? "rewrite" : "pass",
    catalogDetailProportionality: "pass",
    personaConsistency: "pass",
    nativeLanguageExpression: "pass",
  };
  // Reviewer authority is wording only -- it must restate the same
  // communicative act (duration_ask: asking for rental_period, check not
  // started) it reviewed, not merely propose new text.
  return {
    choices: [{ message: { content: JSON.stringify({
      quality,
      issues,
      dimensionChecks,
      reply,
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
}

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

async function composeWithReview({
  candidateReply,
  reviewer,
  itemId = "item_alpha_1",
  itemLabel = "Item Alpha",
  conversationStage = "initial_request",
  recentDialogue = null,
}) {
  let generationCalls = 0;
  let reviewCalls = 0;
  const reviewSystemPrompts = [];
  const generationSystemPrompts = [];
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (objective-fidelity/redundancy judgment, bounded retry
    // correctness), which is unchanged. Canonical Group replies now treat
    // the reviewer as diagnostics-only (never a delivery/rewrite authority)
    // -- see tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: `${itemLabel} rent p chyh`,
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      generationCalls += 1;
      generationSystemPrompts.push(String(args.messages?.[0]?.content ?? ""));
      return schemaValidDurationAskCompletion(candidateReply);
    },
    __languageQualityReviewChatCreateForTests:
      reviewer === undefined
        ? undefined
        : async (args) => {
            reviewCalls += 1;
            reviewSystemPrompts.push(String(args.messages?.[0]?.content ?? ""));
            return reviewer(args, reviewCalls);
          },
  });
  return { generationCalls, reviewCalls, reviewSystemPrompts, generationSystemPrompts, result };
}

// ============================================================
// Test A: known item, rental period missing -- candidate re-asks the item
// ============================================================

test("Test A: a candidate that re-asks about the already-known item is flagged reasks_known_information and rewritten to ask only for the missing rental period", async () => {
  const redundant = "Item Alpha chahiye? Aap ko kitne din chahiye?";
  const focused = "Item Alpha aapko kitne din ke liye chahiye?";
  const { generationCalls, reviewCalls, reviewSystemPrompts, result } = await composeWithReview({
    candidateReply: redundant,
    reviewer: async () => reviewCompletion("rewrite", focused, ["reasks_known_information"]),
  });
  assert.equal(generationCalls, 1, "the deterministic truth/safety guard has no redundancy rule -- it accepts the candidate on attempt 1");
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, focused, "the final reply must ask only for the missing rental period");
  assert.match(
    reviewSystemPrompts[0],
    /FROZEN_REPLY_MEANING \(authoritative\)/,
    "the reviewer must receive the customer-safe duration meaning"
  );
  assert.doesNotMatch(reviewSystemPrompts[0], /"missingInformation":\["rental_period"\]/);
  assert.doesNotMatch(reviewSystemPrompts[0], /OBJECTIVE: collect_missing_rental_period/);
  assert.doesNotMatch(reviewSystemPrompts[0], /REQUESTED_INPUT: rental_period/);
});

// ============================================================
// Test B: a two-question redundant candidate is rewritten to one focused
// request
// ============================================================

test("Test B: a two-question candidate is flagged redundant_question and rewritten into a single focused request", async () => {
  const twoQuestions = "Product Beta chahiye? Aur kitne din ke liye chahiye hoga?";
  const oneQuestion = "Product Beta aapko kitne din ke liye chahiye?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: twoQuestions,
    itemId: "product_beta_1",
    itemLabel: "Product Beta",
    reviewer: async () => reviewCompletion("rewrite", oneQuestion, ["redundant_question"]),
  });
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, oneQuestion);
});

// ============================================================
// Test C: a natural, concise, single-question candidate passes unchanged
// ============================================================

test("Test C: a natural single-question candidate already focused on the missing input passes unchanged", async () => {
  const concise = "Service Gamma aapko kitne din ke liye chahiye?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: concise,
    itemId: "service_gamma_1",
    itemLabel: "Service Gamma",
    reviewer: async () => reviewCompletion("pass", concise, []),
  });
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, concise);
});

// ============================================================
// Test D: several arbitrary, differently-shaped items behave identically
// ============================================================

for (const { itemId, itemLabel } of [
  { itemId: "item_alpha_1", itemLabel: "Item Alpha" },
  { itemId: "product_beta_1", itemLabel: "Product Beta" },
  { itemId: "service_gamma_1", itemLabel: "Service Gamma" },
]) {
  test(`Test D (${itemLabel}): reasks_known_information rewrite is applied identically regardless of item type`, async () => {
    const redundant = `${itemLabel} chahiye? Kitne din ke liye chahiye?`;
    const focused = `${itemLabel} aapko kitne din ke liye chahiye?`;
    const { result } = await composeWithReview({
      candidateReply: redundant,
      itemId,
      itemLabel,
      reviewer: async () => reviewCompletion("rewrite", focused, ["reasks_known_information"]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reply, focused);
  });
}

// ============================================================
// Test E: continuation (already_waiting_for_duration) -- the already-known
// item is still not reconfirmed
// ============================================================

test("Test E: on the already_waiting_for_duration continuation, a candidate that reconfirms the known item is still rewritten", async () => {
  const redundant = "Item Alpha chahiye abhi bhi? Kitne din ke liye chahiye?";
  const focused = "Bas rental period bata dein, Item Alpha aapko kitne din ke liye chahiye?";
  const { reviewCalls, reviewSystemPrompts, result } = await composeWithReview({
    candidateReply: redundant,
    conversationStage: "already_waiting_for_duration",
    // Deliberately worded very differently from `redundant` so the
    // unrelated, pre-existing near-duplicate/repetition guard (comparing
    // the candidate against this exact previous line) is not what causes a
    // rejection here -- this test is isolating the objective-fidelity
    // (reasks_known_information) path specifically.
    recentDialogue: "User: Item Alpha available hai?\nAssistant: Zaroori hai rental period janna, warna exact availability confirm nahi ho sakti.",
    reviewer: async () => reviewCompletion("rewrite", focused, ["reasks_known_information"]),
  });
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, focused);
  assert.match(reviewSystemPrompts[0], /do not re-ask which item they want/i);
});

// ============================================================
// Test F: a rewrite introducing a forbidden fact is still caught by the
// final deterministic guard
// ============================================================

test("Test F: a rewrite that fixes redundancy but introduces a forbidden availability claim is rejected by the deterministic guard", async () => {
  const redundant = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  const unsafeFix = "Item Alpha available hai, aapko kitne din ke liye chahiye?";
  const { result } = await composeWithReview({
    candidateReply: redundant,
    reviewer: async () => reviewCompletion("rewrite", unsafeFix, ["reasks_known_information"]),
  });
  assert.notEqual(result.reply, unsafeFix, "the deterministic guard must reject a rewrite carrying a forbidden claim, even when it also fixes redundancy");
});

// ============================================================
// Test G: poor original + unsafe first rewrite -- the bounded corrective
// retry produces a safe, focused reply
// ============================================================

test("Test G: an unsafe first rewrite triggers exactly one corrective retry, which succeeds when it proposes a safe reply", async () => {
  const redundant = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  const unsafeFirstRewrite = "Item Alpha available hai, kitne din ke liye chahiye?";
  const safeCorrectiveRewrite = "Item Alpha aapko kitne din ke liye chahiye?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: redundant,
    reviewer: async (_args, callNumber) =>
      callNumber === 1
        ? reviewCompletion("rewrite", unsafeFirstRewrite, ["reasks_known_information"])
        : reviewCompletion("rewrite", safeCorrectiveRewrite, ["reasks_known_information"]),
  });
  assert.equal(reviewCalls, 2, "exactly one bounded corrective retry after the first rewrite fails the guard");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, safeCorrectiveRewrite, "the corrective retry's safe reply must be delivered, not the unsafe first rewrite or the known-poor original");
});

test("Test G (exhausted): when the corrective retry also fails the guard, the known-poor original is not shipped -- safe fallback is used, and there is no further retry", async () => {
  const redundant = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  const alwaysUnsafe = "Item Alpha available hai, kitne din ke liye chahiye?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: redundant,
    reviewer: async () => reviewCompletion("rewrite", alwaysUnsafe, ["reasks_known_information"]),
  });
  assert.equal(reviewCalls, 2, "no more than one corrective retry -- never an unbounded loop");
  assert.notEqual(result.reply, alwaysUnsafe);
  assert.notEqual(result.reply, redundant, "the known-poor original must not be silently shipped once the reviewer has already judged it poor and no safe rewrite was produced");
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.equal(result.outcome, "fallback");
});

// ============================================================
// Test H: language independence -- no Roman-Urdu-specific lexical logic
// governs objective-fidelity detection
// ============================================================

test("Test H: an English candidate that redundantly re-confirms the item is reviewed and rewritten the same way, with no language-specific code path", async () => {
  const redundant = "Do you still want Item Alpha? How many days do you need it for?";
  const focused = "How many days do you need Item Alpha for?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: redundant,
    reviewer: async () => reviewCompletion("rewrite", focused, ["redundant_question"]),
  });
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, focused);
});

// ============================================================
// Codex-audit follow-up: the PRIMARY composer must receive the exact
// canonical replyPolicy.interactionGuidance object (not a hand-reconstructed
// equivalent), the duration-specific prose must not independently duplicate
// known/missing rules, and the reviewer must receive the SAME object.
// ============================================================

test("Blocker A: the primary duration_ask composer prompt uses one customer-safe meaning and does not dump interactionGuidance JSON", async () => {
  const concise = "Item Alpha aapko kitne din ke liye chahiye?";
  const { generationSystemPrompts } = await composeWithReview({
    candidateReply: concise,
    reviewer: async () => reviewCompletion("pass", concise, []),
  });
  const systemPrompt = generationSystemPrompts[0];
  assert.match(systemPrompt, /FROZEN_REPLY_MEANING \(authoritative, wording-only\)/);
  assert.doesNotMatch(systemPrompt, /INTERACTION GUIDANCE \(authoritative\):/);
  assert.doesNotMatch(systemPrompt, /collect_missing_rental_period|rental_period|rental_duration|for_period/);
});

test("Blocker B: duration_ask KIND instruction does not restated the frozen meaning", async () => {
  const concise = "Item Alpha aapko kitne din ke liye chahiye?";
  const { generationSystemPrompts } = await composeWithReview({
    candidateReply: concise,
    reviewer: async () => reviewCompletion("pass", concise, []),
  });
  const systemPrompt = generationSystemPrompts[0];
  const meaningCount = (systemPrompt.match(/FROZEN_REPLY_MEANING \(authoritative, wording-only\)/g) || []).length;
  assert.equal(meaningCount, 1, "duration meaning must appear once");
  const durationSpecificLine = systemPrompt
    .split("\n")
    .find((line) => line.startsWith("- If KIND=duration_ask,"));
  assert.ok(durationSpecificLine, "the duration_ask structural bullet must still be present");
  assert.doesNotMatch(durationSpecificLine, /how many days they need the trusted item for/);
  assert.doesNotMatch(durationSpecificLine, /duration of use|unmistakable/i);
  assert.doesNotMatch(durationSpecificLine, /requestedInput=rental_period/);
});

test("Blocker C: the language-quality reviewer receives the same customer-safe meaning, not interactionGuidance JSON", async () => {
  const concise = "Item Alpha aapko kitne din ke liye chahiye?";
  const { generationSystemPrompts, reviewSystemPrompts } = await composeWithReview({
    candidateReply: concise,
    reviewer: async () => reviewCompletion("pass", concise, []),
  });
  assert.match(generationSystemPrompts[0], /FROZEN_REPLY_MEANING \(authoritative, wording-only\)/);
  assert.match(reviewSystemPrompts[0], /FROZEN_REPLY_MEANING \(authoritative\)/);
  assert.match(reviewSystemPrompts[0], /incomplete_for_period/);
  assert.match(reviewSystemPrompts[0], /duration-of-use relationship itself is mandatory/);
  assert.doesNotMatch(reviewSystemPrompts[0], /INTERACTION_GUIDANCE:/);
  assert.doesNotMatch(reviewSystemPrompts[0], /OBJECTIVE: collect_missing_rental_period/);
  assert.doesNotMatch(reviewSystemPrompts[0], /REQUESTED_INPUT: rental_period/);
});

// ============================================================
// Blocker: reviewer infrastructure failure/malformed response must not be
// treated as quality=pass when review is required.
// ============================================================

test("Blocker E: a reviewer that always throws never results in the unreviewed original being silently delivered as though it passed", async () => {
  const candidate = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (objective-fidelity/redundancy judgment, bounded retry
    // correctness), which is unchanged. Canonical Group replies now treat
    // the reviewer as diagnostics-only (never a delivery/rewrite authority)
    // -- see tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha rent p chyh",
    trustedFacts: { itemId: "item_alpha_1", itemLabel: "Item Alpha" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => schemaValidDurationAskCompletion(candidate),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      throw new Error("simulated reviewer infrastructure failure");
    },
  });
  assert.equal(reviewCalls, 2, "exactly one bounded technical retry after the first failure -- never a loop");
  assert.notEqual(result.reply, candidate, "an unreviewed candidate must never be silently delivered as though review passed");
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.equal(result.outcome, "fallback");
});

test("Blocker E (malformed): a reviewer that returns unparseable JSON is treated as a technical failure, not quality=pass", async () => {
  const candidate = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (objective-fidelity/redundancy judgment, bounded retry
    // correctness), which is unchanged. Canonical Group replies now treat
    // the reviewer as diagnostics-only (never a delivery/rewrite authority)
    // -- see tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha rent p chyh",
    trustedFacts: { itemId: "item_alpha_1", itemLabel: "Item Alpha" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => schemaValidDurationAskCompletion(candidate),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      return { choices: [{ message: { content: "not valid json at all" } }] };
    },
  });
  assert.equal(reviewCalls, 2);
  assert.notEqual(result.reply, candidate);
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.equal(result.outcome, "fallback");
});

// ============================================================
// Blocker F: exactly one bounded technical retry, and it can succeed
// ============================================================

test("Blocker F: a reviewer that fails once then succeeds is retried exactly once and its verdict is delivered", async () => {
  const concise = "Item Alpha aapko kitne din ke liye chahiye?";
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (objective-fidelity/redundancy judgment, bounded retry
    // correctness), which is unchanged. Canonical Group replies now treat
    // the reviewer as diagnostics-only (never a delivery/rewrite authority)
    // -- see tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha rent p chyh",
    trustedFacts: { itemId: "item_alpha_1", itemLabel: "Item Alpha" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => schemaValidDurationAskCompletion(concise),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error("transient failure");
      return reviewCompletion("pass", concise, []);
    },
  });
  assert.equal(reviewCalls, 2, "exactly one retry after the first technical failure");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, concise, "the reviewed (pass) candidate must be delivered once the retry succeeds");
});

// ============================================================
// Blocker G: retry exhausted -- safe fallback, no further loop
// ============================================================

test("Blocker G: when the bounded technical retry also fails, there is no third attempt and the safe fallback is used", async () => {
  const candidate = "Item Alpha chahiye? Kitne din ke liye chahiye?";
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (objective-fidelity/redundancy judgment, bounded retry
    // correctness), which is unchanged. Canonical Group replies now treat
    // the reviewer as diagnostics-only (never a delivery/rewrite authority)
    // -- see tests/canonical-group-reviewer-non-blocking.test.mjs.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha rent p chyh",
    trustedFacts: { itemId: "item_alpha_1", itemLabel: "Item Alpha" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => schemaValidDurationAskCompletion(candidate),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      throw new Error("persistent failure");
    },
  });
  assert.equal(reviewCalls, 2, "no third attempt -- the retry is bounded to exactly one");
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.equal(result.outcome, "fallback");
});
