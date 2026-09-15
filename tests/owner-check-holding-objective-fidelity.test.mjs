/**
 * Positive-objective-fidelity/item-reference adversarial matrix for the
 * owner_check_holding compose kind in composeCloudCanonicalCustomerReply --
 * i.e. the required-claim + reviewer-revalidation + item-reference-
 * provenance MECHANISM itself, independent of which channel delivers it.
 *
 * Exercised via channel="dm": canonical Group replies now treat the
 * language-quality reviewer as diagnostics-only (never a delivery/rewrite
 * authority -- see "MAKE THE LANGUAGE REVIEWER NON-BLOCKING FOR CANONICAL
 * GROUP REPLIES"), so a reviewer-rewrite-revalidation test no longer applies
 * to channel="group". The underlying deterministic guard/contract mechanics
 * asserted here (requiredClaims, itemReferenceRequirement, provenance
 * checks) are channel-agnostic and unchanged; DM still uses the reviewer
 * authoritatively, so it remains the right channel to exercise them.
 * tests/canonical-group-reviewer-non-blocking.test.mjs covers the
 * Group-specific non-blocking behavior, including the exact live
 * owner_check_holding regression fixture ("Toyota Corolla ke liye koi
 * update nahi hai").
 *
 * Root cause (real WhatsApp, original defect): a frozen owner_check_holding
 * contract froze only negative safety (no confirmed/unavailable/price/
 * booking claims) -- nothing required the reply to actually convey that the
 * request is being progressed. Fixed by: (1) a REQUIRED positive claim
 * (resource_availability_unconfirmed) the delivered text must convey, (2)
 * revalidating a reviewer's rewrite against the full contract (not just
 * accepting it because only wording changed), (3) sourcing/preserving the
 * customer's own trusted item wording (customerReference) end to end.
 *
 * Every fixture below uses a synthetic, non-catalog item name/reference --
 * none of this depends on Corolla/Stonic/Civic, car rental, or Roman Urdu.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function primaryCompletion(reply, overrides = {}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply: reply,
          replySemantics: {
            claims: ["resource_availability_unconfirmed"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: false,
          requestedInput: null,
          availabilityCheckStarted: true,
          ...overrides,
        }),
      },
    }],
  };
}

function reviewCompletion({ reply, claims = [], overrides = {} }) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          quality: "rewrite",
          issues: ["unnecessarily_verbose"],
          dimensionChecks: {
            naturalWordOrder: "pass",
            modifierAttachment: "pass",
            spokenFluency: "pass",
            directnessAndEfficiency: "rewrite",
            objectiveFidelity: "pass",
            catalogDetailProportionality: "pass",
            personaConsistency: "pass",
            nativeLanguageExpression: "pass",
          },
          reply,
          replySemantics: {
            claims,
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: false,
          requestedInput: null,
          availabilityCheckStarted: true,
          ...overrides,
        }),
      },
    }],
  };
}

function baseCall(overrides = {}) {
  return {
    kind: "owner_check_holding",
    // DM channel: this file proves the reviewer-revalidation + required-
    // claim + item-reference-provenance MECHANISM itself, which is
    // unchanged (the deterministic guard checks are channel-agnostic).
    // Canonical Group replies now treat the reviewer as diagnostics-only
    // (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that
    // Group-specific coverage, including the exact live owner_check_holding
    // regression fixture.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "koi update?",
    trustedFacts: { itemId: "syn-item-1", itemLabel: "Synthetic Resource" },
    timeoutMs: 8000,
    ...overrides,
  };
}

test("live-failure regression: a rewrite equivalent to 'no update' (missing the required unconfirmed-progress claim) is rejected; corrective retry also fails closed", async () => {
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Filhaal process jari hai."),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      // Structurally honest about what the rewrite actually says: no claims
      // at all -- it does not convey that the request is being progressed.
      return reviewCompletion({
        reply: "Synthetic Resource ke liye koi update nahi hai.",
        claims: [],
      });
    },
  });
  assert.equal(
    reviewCalls,
    2,
    "the missing required claim triggers the existing bounded corrective retry, which also fails the same way"
  );
  assert.equal(result.ok, true, "a safe fallback is still delivered (never empty/never the bad rewrite)");
  assert.equal(result.outcome, "fallback");
  assert.doesNotMatch(result.reply, /koi update nahi hai/i);
});

test("a valid holding candidate passes regardless of surface wording, as long as its structured semantics convey the required meaning", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Abhi tak koi confirmation nahi aya, jaise hi milay ga bata dun ga."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Filhaal process jari hai, confirm hote hi update mil jaye ga.",
        claims: ["resource_availability_unconfirmed"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Filhaal process jari hai, confirm hote hi update mil jaye ga.");
});

test("adversarial: a rewrite that re-asks for the rental duration is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Aapko kitne din ke liye chahiye?",
        claims: ["resource_availability_unconfirmed"],
        overrides: { customerInputRequested: true, requestedInput: "rental_period" },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite that asks the customer to confirm/check availability themselves is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Kya aap khud confirm kar sakte hain ke available hai ya nahi?",
        claims: [],
        overrides: { customerInputRequested: true, requestedInput: "start_date" },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite that claims confirmed availability is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Synthetic Resource available hai.",
        claims: ["resource_availability_confirmed"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite that claims unavailability is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Synthetic Resource available nahi hai.",
        claims: ["resource_unavailable"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite that leaks a price is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Rate 8000 per din hai, progress ho raha hai.",
        claims: ["resource_availability_unconfirmed", "quotation_verified"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite that claims booking success is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Aapki booking confirm ho gayi hai.",
        claims: ["resource_availability_unconfirmed", "reservation_created"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite giving an unsupported exact-timing promise is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "5 minute mein confirm ho jaye ga.",
        claims: ["resource_availability_unconfirmed"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("adversarial: a rewrite mentioning owner/staff/manual review/internal process is rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Owner se confirm karwa rahe hain, thori der lagay gi.",
        claims: ["resource_availability_unconfirmed"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("bounded corrective retry accepts a fixed rewrite when the second attempt actually repairs the violation", async () => {
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return reviewCompletion({
          reply: "Synthetic Resource ke liye koi update nahi hai.",
          claims: [],
        });
      }
      return reviewCompletion({
        reply: "Abhi confirm nahi hua, update milay ga.",
        claims: ["resource_availability_unconfirmed"],
      });
    },
  });
  assert.equal(reviewCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Abhi confirm nahi hua, update milay ga.");
});

test("generic coverage: an arbitrary synthetic item name and non-Roman-Urdu wording behave identically -- the fix never depends on a specific item or language", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    // DM channel: this file proves the reviewer-revalidation + required-
    // claim + item-reference-provenance MECHANISM itself, which is
    // unchanged (the deterministic guard checks are channel-agnostic).
    // Canonical Group replies now treat the reviewer as diagnostics-only
    // (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that
    // Group-specific coverage, including the exact live owner_check_holding
    // regression fixture.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "any update?",
    trustedFacts: { itemId: "zz-999", itemLabel: "Arbitrary Widget Nine" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Still in progress.", {
        replySemantics: {
          claims: ["resource_availability_unconfirmed"],
          languageStyle: "english",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "There is no update on this yet.",
        claims: [],
        overrides: {
          replySemantics: {
            claims: [],
            languageStyle: "english",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

// ============================================================
// Root Cause 3 / Section 6: customerReference provenance. When a trusted
// customerReference exists for this turn, the delivered reply must contain
// that exact wording, and a rewrite that drops it (even while otherwise
// conveying the required claim) must be rejected.
// ============================================================

test("item-reference required: a rewrite that drops the customer's own trusted item wording is rejected even though it conveys the required claim", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    // DM channel: this file proves the reviewer-revalidation + required-
    // claim + item-reference-provenance MECHANISM itself, which is
    // unchanged (the deterministic guard checks are channel-agnostic).
    // Canonical Group replies now treat the reviewer as diagnostics-only
    // (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that
    // Group-specific coverage, including the exact live owner_check_holding
    // regression fixture.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Synth ke liye koi update?",
    trustedFacts: {
      itemId: "syn-item-2",
      itemLabel: "Synthetic Resource Two",
      customerReference: "Synth",
    },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Synth ke liye abhi process jari hai.", {
        referencedItemId: "syn-item-2",
        referencedItemSurface: "Synth",
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Abhi process jari hai.",
        claims: ["resource_availability_unconfirmed"],
        overrides: {
          referencedItemId: "syn-item-2",
          referencedItemSurface: "Synth",
        },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("item-reference required: a rewrite that declares a mismatched referencedItemId/referencedItemSurface is rejected even if the reply text happens to contain the trusted wording", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    // DM channel: this file proves the reviewer-revalidation + required-
    // claim + item-reference-provenance MECHANISM itself, which is
    // unchanged (the deterministic guard checks are channel-agnostic).
    // Canonical Group replies now treat the reviewer as diagnostics-only
    // (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that
    // Group-specific coverage, including the exact live owner_check_holding
    // regression fixture.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Synth ke liye koi update?",
    trustedFacts: {
      itemId: "syn-item-3",
      itemLabel: "Synthetic Resource Three",
      customerReference: "Synth",
    },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Synth ke liye abhi process jari hai.", {
        referencedItemId: "syn-item-3",
        referencedItemSurface: "Synth",
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Synth ke liye abhi bhi process jari hai.",
        claims: ["resource_availability_unconfirmed"],
        overrides: {
          referencedItemId: "wrong-item-id",
          referencedItemSurface: "Synth",
        },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("item-reference required: a rewrite that preserves the trusted wording and correctly declares provenance is accepted", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    // DM channel: this file proves the reviewer-revalidation + required-
    // claim + item-reference-provenance MECHANISM itself, which is
    // unchanged (the deterministic guard checks are channel-agnostic).
    // Canonical Group replies now treat the reviewer as diagnostics-only
    // (never a delivery/rewrite authority) -- see
    // tests/canonical-group-reviewer-non-blocking.test.mjs for that
    // Group-specific coverage, including the exact live owner_check_holding
    // regression fixture.
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Synth ke liye koi update?",
    trustedFacts: {
      itemId: "syn-item-4",
      itemLabel: "Synthetic Resource Four",
      customerReference: "Synth",
    },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Synth ke liye abhi process jari hai.", {
        referencedItemId: "syn-item-4",
        referencedItemSurface: "Synth",
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Synth ke liye confirm hote hi bata dun ga.",
        claims: ["resource_availability_unconfirmed"],
        overrides: {
          referencedItemId: "syn-item-4",
          referencedItemSurface: "Synth",
        },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Synth ke liye confirm hote hi bata dun ga.");
});

test("item-reference optional: when no trusted customerReference exists, a rewrite need not mention any specific item wording", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    ...baseCall(),
    __chatCompletionsCreateForTests: async () =>
      primaryCompletion("Progress ho raha hai."),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewCompletion({
        reply: "Confirm hote hi update mil jaye ga.",
        claims: ["resource_availability_unconfirmed"],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
});
