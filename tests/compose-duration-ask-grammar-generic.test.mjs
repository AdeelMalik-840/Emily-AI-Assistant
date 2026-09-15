/**
 * Grammar/naturalness quality for duration_ask is now owned entirely by the
 * AI composition layer, never by deterministic regex/word-order matching.
 *
 * A prior round widened a regex backstop (ROMAN_URDU_FOR_THEN_DURATION_PATTERN)
 * to tolerate a bounded gap of intervening words. Even though it was
 * item/group-independent, it still hardcoded specific Roman-Urdu lexical
 * forms and word ordering in production decision logic ("ke liye", "kitne",
 * duration-unit words) -- exactly the architecture this repo is moving away
 * from. That regex, and the function that used it
 * (isMalformedRomanUrduDurationAskGrammar), have been removed entirely from
 * composeCloudCanonicalCustomerReply.js. Nothing was added in its place that
 * matches words, phrases, or word order in deterministic code.
 *
 * New architecture: STATE/POLICY decides WHAT may be said (replyPolicy,
 * buildCustomerReplyPolicy -- an ABSTRACT, language-agnostic
 * linguisticGuidance field, no exact words/postpositions/word order). The AI
 * decides HOW to say it naturally, including a dedicated language-quality
 * review/rewrite step inside the SAME compose pipeline (no second Brain):
 * generate -> deterministic truth/safety guard -> AI language-quality
 * review/rewrite -> deterministic truth/safety guard again -> deliver. The
 * review step is injectable via __languageQualityReviewChatCreateForTests,
 * kept separate from __chatCompletionsCreateForTests (the primary
 * generation call) so existing/unrelated tests are never forced through an
 * extra call they never asked for.
 *
 * Every fixture below is a deliberately generic, non-production item label
 * -- the review step's gate (replyPolicy.linguisticGuidance) is keyed only
 * by compose kind, never by item/group identity, so any future item/group
 * gets the same behavior automatically. Tests mock the language-quality
 * reviewer's structured decision; they never teach production code grammar
 * through regex.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { buildCustomerReplyPolicy } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);

function reviewCompletion(quality, reply, issues = [], dimensionOverrides = {}, executionOverrides = {}) {
  const dimensionChecks = {
    naturalWordOrder: "pass",
    modifierAttachment: "pass",
    spokenFluency: quality === "rewrite" ? "rewrite" : "pass",
    directnessAndEfficiency: "pass",
    objectiveFidelity: "pass",
    catalogDetailProportionality: "pass",
    personaConsistency: "pass",
    nativeLanguageExpression: "pass",
    ...dimensionOverrides,
  };
  // Reviewer authority is wording only -- it must restate the same
  // communicative act (duration_ask: asking for rental_period, check not
  // started) it reviewed, not merely propose new text.
  const execution = {
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    customerInputRequested: true,
    requestedInput: "rental_period",
    availabilityCheckStarted: false,
    ...executionOverrides,
  };
  return {
    choices: [{ message: { content: JSON.stringify({ quality, issues, dimensionChecks, reply, ...execution }) } }],
  };
}

function schemaValidDurationAskCompletion(customerReply, languageStyle = "roman_urdu") {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested: true,
      requestedInput: "rental_period",
      availabilityCheckStarted: false,
      replySemantics: {
        claims: [],
        languageStyle,
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  };
}

async function composeWithReview({
  candidateReply,
  reviewer,
  itemId = "generic_item_1",
  itemLabel = "Generic Item",
  conversationStage = "initial_request",
  recentDialogue = null,
  languageStyle = "roman_urdu",
}) {
  let generationCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    // DM channel: this file proves the language-quality reviewer MECHANISM
    // itself (grammar/rewrite/corrective-retry correctness), which is
    // unchanged. Canonical Group replies now treat the reviewer as
    // diagnostics-only (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that coverage.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: `${itemLabel} rent p chyh`,
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      generationCalls += 1;
      return schemaValidDurationAskCompletion(candidateReply, languageStyle);
    },
    __languageQualityReviewChatCreateForTests:
      typeof reviewer === "function"
        ? async (args) => {
            reviewCalls += 1;
            return reviewer(args);
          }
        : undefined,
  });
  return { generationCalls, reviewCalls, result };
}

// ============================================================
// Test A: an awkward candidate is rewritten naturally by the reviewer, and
// the rewrite is what gets delivered
// ============================================================

test("Test A: an awkward candidate is flagged unnatural_word_order and the reviewer's natural rewrite is delivered", async () => {
  const awkward = "Sedan Alpha ke liye aapko kitne din chahiye?";
  const natural = "Sedan Alpha aapko kitne din ke liye chahiye?";
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: awkward,
    itemId: "sedan_alpha_1",
    itemLabel: "Sedan Alpha",
    reviewer: async () => reviewCompletion("rewrite", natural, ["unnatural_word_order"]),
  });
  assert.equal(generationCalls, 1, "the deterministic truth/safety guard has no grammar rule -- the awkward candidate is accepted on attempt 1");
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural, "the reviewer's rewrite must be what is delivered, not the awkward candidate");
});

// ============================================================
// Test B: an already-natural reply is left unchanged (quality=pass)
// ============================================================

test("Test B: reviewer returns quality=pass and the candidate is delivered unchanged", async () => {
  const natural = "Vehicle Beta aapko kitne din ke liye chahiye?";
  let reviewSawCandidate = null;
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: natural,
    itemId: "vehicle_beta_1",
    itemLabel: "Vehicle Beta",
    reviewer: async (args) => {
      reviewSawCandidate = String(args.messages.at(-1)?.content ?? "");
      return reviewCompletion("pass", natural, []);
    },
  });
  assert.equal(generationCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.match(reviewSawCandidate, /Vehicle Beta/, "the reviewer must actually receive the candidate reply");
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural);
});

test("Test B2: a holistic pass cannot bypass an explicit word-order or attachment failure", async () => {
  const awkward = "Aapko kitne din chahiye Resource Delta ke liye?";
  const natural = "Resource Delta aapko kitne din ke liye chahiye?";
  let calls = 0;
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: awkward,
    itemId: "resource_delta_1",
    itemLabel: "Resource Delta",
    reviewer: async () => {
      calls += 1;
      return calls === 1
        ? reviewCompletion("pass", awkward, [], {
            naturalWordOrder: "rewrite",
            modifierAttachment: "rewrite",
          })
        : reviewCompletion("rewrite", natural, ["unnatural_modifier_attachment"], {
            modifierAttachment: "rewrite",
          });
    },
  });
  assert.equal(reviewCalls, 2, "an internally inconsistent pass receives only the bounded reviewer retry");
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural);
});

test("shared duration and holding policies keep identity-free voice; duration_ask meaning is not linguisticGuidance", () => {
  const duration = buildCustomerReplyPolicy("duration_ask", { itemId: "item_alpha" });
  const holding = buildCustomerReplyPolicy("owner_check_holding", { itemId: "item_beta" });
  assert.equal(duration.linguisticGuidance, null);
  assert.equal(duration.requestedInput, "rental_period");
  assert.match(holding.linguisticGuidance, /stable Emily voice/i);
  assert.match(holding.linguisticGuidance, /gender-neutral/i);
  assert.match(holding.linguisticGuidance, /established feminine voice/i);
  assert.match(holding.linguisticGuidance, /internal ontology labels/i);
  assert.doesNotMatch(holding.linguisticGuidance, /item_alpha|item_beta/i);
});

test("a persona-inconsistent holistic pass is rejected and receives only the bounded reviewer retry", async () => {
  let calls = 0;
  const candidate = "Main pooch raha hun ke Resource Theta kitne din ke liye chahiye?";
  const corrected = "Resource Theta kitne din ke liye chahiye?";
  const { reviewCalls, result } = await composeWithReview({
    candidateReply: candidate,
    itemId: "resource_theta_1",
    itemLabel: "Resource Theta",
    reviewer: async () => {
      calls += 1;
      return calls === 1
        ? reviewCompletion("pass", candidate, [], { personaConsistency: "rewrite" })
        : reviewCompletion("rewrite", corrected, ["awkward_self_reference"], {
            personaConsistency: "rewrite",
          });
    },
  });
  assert.equal(reviewCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.reply, corrected);
});

for (const fixture of [
  {
    issue: "unnecessarily_verbose",
    candidate:
      "To continue with your request for Resource Delta, I need you to provide the rental period so I can proceed with the next step.",
  },
  {
    issue: "process_narration",
    candidate:
      "I need the rental period because that information is required before I can start the availability-checking process for Resource Delta.",
  },
  {
    issue: "awkward_self_reference",
    candidate:
      "For me to be able to help you with Resource Delta, I will need you to tell me the rental period.",
  },
  {
    issue: "literal_translation",
    candidate:
      "For Resource Delta's taking, the rental period how much is needed by you?",
  },
  {
    issue: "unnatural_modifier_attachment",
    candidate:
      "Aapko kitne din chahiye Resource Delta ke liye?",
  },
  {
    issue: "translated_sentence_structure",
    candidate:
      "How many days are needed by you for Resource Delta?",
  },
  {
    issue: "spoken_fluency_failure",
    candidate:
      "For Resource Delta, the days needed by you are how many?",
  },
  {
    issue: "conversational_act_mismatch",
    candidate:
      "Resource Delta is what you want, but first let me restate that request before asking how many days you need it.",
  },
  {
    issue: "unnecessary_intent_restatement",
    candidate:
      "You want to rent Resource Delta and are asking about it, so please now tell me the rental period.",
  },
  {
    issue: "awkward_or_unjustified_contrast",
    candidate:
      "Resource Delta is the requested item, however please tell me the rental period.",
  },
  {
    issue: "unnecessary_process_narration",
    candidate:
      "The next step in handling the request is for me to collect the rental period from you.",
  },
  {
    issue: "catalog_overexpression",
    candidate:
      "You requested Resource Delta Premium Edition Model Year 2028 in its listed configuration; please provide the rental period.",
  },
]) {
  test(`generic quality rubric rewrites a structurally safe ${fixture.issue} duration reply`, async () => {
    let reviewerSystem = "";
    const { reviewCalls, result } = await composeWithReview({
      candidateReply: fixture.candidate,
      itemId: "resource_delta_1",
      itemLabel: "Resource Delta",
      languageStyle: "english",
      reviewer: async (args) => {
        reviewerSystem = String(args.messages?.[0]?.content ?? "");
        return reviewCompletion(
          "rewrite",
          "Please share the rental period for Resource Delta.",
          [fixture.issue]
        );
      },
    });
    assert.equal(reviewCalls, 1);
    assert.equal(result.ok, true);
    assert.notEqual(result.reply, fixture.candidate);
    assert.ok(String(result.reply).trim());
    assert.match(reviewerSystem, /shortest natural response/i);
    assert.match(reviewerSystem, /process narration/i);
    assert.match(reviewerSystem, /self-referential/i);
    assert.match(reviewerSystem, /literal\/translated-sounding/i);
    assert.match(reviewerSystem, /modifier attachment/i);
    assert.match(reviewerSystem, /fluent speaker/i);
    assert.match(reviewerSystem, /incomplete_for_period/);
    assert.match(reviewerSystem, /duration-of-use relationship itself is mandatory/);
    assert.match(reviewerSystem, /Do not require a particular grammatical marker/i);
    assert.doesNotMatch(reviewerSystem, /REQUESTED_INPUT: rental_period/);
    assert.doesNotMatch(reviewerSystem, /OBJECTIVE: collect_missing_rental_period/);
    assert.doesNotMatch(reviewerSystem, /INTERACTION_GUIDANCE:/);
  });
}

// ============================================================
// Test C: a rewrite that introduces a forbidden claim is rejected by the
// final deterministic guard -- language review cannot bypass truth policy
// ============================================================

test("Test C: a rewrite that introduces a forbidden availability claim is rejected by the deterministic guard, both on the first rewrite and the bounded corrective retry", async () => {
  const safeOriginal = "Product Gamma aapko kitne din ke liye chahiye?";
  const unsafeRewrite = "Product Gamma available hai, aapko kitne din ke liye chahiye?";
  // The mock reviewer always proposes the same unsafe rewrite, so this
  // proves the corrective retry (see Test G) -- not just the first rewrite
  // -- also gets rejected by the deterministic guard, and the known-poor
  // original is never shipped in that exhausted case (existing safe-failure
  // fallback is used instead).
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: safeOriginal,
    itemId: "product_gamma_1",
    itemLabel: "Product Gamma",
    reviewer: async () => reviewCompletion("rewrite", unsafeRewrite, ["awkward_translation"]),
  });
  assert.equal(generationCalls, 1);
  assert.equal(reviewCalls, 2, "first rewrite attempt + one bounded corrective retry");
  assert.notEqual(result.reply, unsafeRewrite, "the deterministic guard must reject a rewrite carrying a forbidden claim");
  assert.equal(result.reply, "FALLBACK_UNUSED", "exhausted corrective retry falls back to the deterministic fallback, not the already-judged-poor original");
  assert.equal(result.outcome, "fallback");
});

// ============================================================
// Test D: several arbitrary generic items behave identically -- the review
// step's gate is the compose kind's policy, never item identity
// ============================================================

for (const { itemId, itemLabel } of [
  { itemId: "sedan_alpha_1", itemLabel: "Sedan Alpha" },
  { itemId: "vehicle_beta_1", itemLabel: "Vehicle Beta" },
  { itemId: "product_gamma_1", itemLabel: "Product Gamma (Variant One)" },
]) {
  test(`Test D (${itemLabel}): reviewer rewrite is applied identically regardless of item label`, async () => {
    const awkward = `${itemLabel} ke liye aapko kitne din chahiye?`;
    const natural = `${itemLabel} aapko kitne din ke liye chahiye?`;
    const { result } = await composeWithReview({
      candidateReply: awkward,
      itemId,
      itemLabel,
      reviewer: async () => reviewCompletion("rewrite", natural, ["unnatural_word_order"]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.reply, natural);
  });
}

// ============================================================
// Test E: the architecture does not depend on Roman-Urdu word lists --
// English and mixed-language candidates go through the exact same review
// gate with no language-specific code path
// ============================================================

test("Test E: an English candidate is reviewed the same way, with no Roman-Urdu-specific code path", async () => {
  const awkward = "For Sedan Alpha, how many days you need?";
  const natural = "How many days do you need Sedan Alpha for?";
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: awkward,
    itemId: "sedan_alpha_1",
    itemLabel: "Sedan Alpha",
    languageStyle: "english",
    reviewer: async () => reviewCompletion("rewrite", natural, ["unnatural_word_order"]),
  });
  assert.equal(generationCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural);
});

test("Test E: a mixed-language candidate is reviewed the same way", async () => {
  const awkward = "Vehicle Beta ke liye how many days chahiye?";
  const natural = "Vehicle Beta ke liye kitne din chahiye, how many days do you need?";
  const { result } = await composeWithReview({
    candidateReply: awkward,
    itemId: "vehicle_beta_1",
    itemLabel: "Vehicle Beta",
    languageStyle: "mixed",
    reviewer: async () => reviewCompletion("rewrite", natural, ["awkward_translation"]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural);
});

// ============================================================
// Test F: the same language-quality process applies on the
// already_waiting_for_duration continuation stage
// ============================================================

test("Test F: already_waiting_for_duration continuation goes through the same review/rewrite process", async () => {
  const awkward = "Product Gamma (Variant One) ke liye aapko phir se kitne din chahiye?";
  const natural = "Product Gamma (Variant One) aapko kitne din ke liye chahiye, dobara pooch rahi hun?";
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: awkward,
    itemId: "product_gamma_1",
    itemLabel: "Product Gamma (Variant One)",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "User: Product Gamma available hai?\nAssistant: Product Gamma kab tak chahiye hoga?",
    reviewer: async () => reviewCompletion("rewrite", natural, ["unnatural_word_order"]),
  });
  assert.equal(generationCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reply, natural);
});

// ============================================================
// Additional safety: no dedicated review hook (a test double for the
// primary call only) means the review step is skipped -- the candidate
// that already passed the deterministic guard is delivered as-is, and no
// real network call is attempted.
// ============================================================

test("no review hook provided: candidate that already passed the deterministic guard is delivered unchanged, review step skipped", async () => {
  const candidate = "Sedan Alpha aapko kitne din ke liye chahiye?";
  const { generationCalls, reviewCalls, result } = await composeWithReview({
    candidateReply: candidate,
    itemId: "sedan_alpha_1",
    itemLabel: "Sedan Alpha",
    reviewer: null,
  });
  assert.equal(generationCalls, 1);
  assert.equal(reviewCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.reply, candidate);
});

test("unrelated compose kind is never subject to the duration_ask-only language review", async () => {
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "social",
    channel: "group",
    semanticIntent: "unknown",
    customerMessage: "salam",
    trustedFacts: {},
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Walaikum salam!",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      return reviewCompletion("pass", "Walaikum salam!", []);
    },
  });
  assert.equal(reviewCalls, 0, "kind=social has no linguisticGuidance, so the review step must not fire at all");
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Walaikum salam!");
});
