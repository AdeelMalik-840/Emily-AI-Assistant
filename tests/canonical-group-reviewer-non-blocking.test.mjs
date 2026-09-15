/**
 * Live WhatsApp failure: Corolla availability_inquiry -> composeKind=duration_ask
 * reached a valid primary candidate, but the language-quality reviewer came
 * back reviewStatus=unavailable (twice, through the existing bounded retry),
 * and the composer treated that as forced_fallback_review_unavailable --
 * discarding the already-valid, already-deterministically-validated primary
 * reply and sending the generic "Maazrat, rental duration ya dates bata dein
 * taake main madad kar sakun." apology instead.
 *
 * Fix under test: for canonical Group replies (channel="group"), the
 * language reviewer is no longer a delivery authority. It may still run and
 * be logged, but:
 *   - a valid primary candidate is delivered regardless of reviewer status
 *   - reviewer unavailable/timeout/invalid never triggers fallback
 *   - a reviewer-proposed rewrite is never used for delivery
 * DM/Cloud (channel="dm") behavior is explicitly untouched by this fix.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } = await import(
  "../src/brain/contracts/cloudCanonicalSemantic.js"
);
const { sameActFallbackReply } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { normalizePlaywrightOutboundTrace } = await import(
  "../src/services/playwrightInboundCursorStore.js"
);

function durationAskCompletion(reply, overrides = {}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply: reply,
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
          ...overrides,
        }),
      },
    }],
  };
}

function ownerCheckHoldingCompletion(reply, overrides = {}) {
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

async function throwingReviewer() {
  throw new Error("simulated reviewer infra failure");
}

async function timeoutReviewer() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error("should not resolve before timeout race");
}

function reviewRewriteCompletion({ reply, claims = [], overrides = {} }) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
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
          reply,
          replySemantics: {
            claims,
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
          ...overrides,
        }),
      },
    }],
  };
}

// ============================================================
// Case 1: valid primary candidate, reviewer unavailable/timeout/error
// ============================================================

test("Case 1a: valid duration_ask + reviewer unavailable -> primary is delivered, not the fallback apology", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success", "must not be forced into fallback");
  assert.equal(result.source, "openai_group_availability_compose");
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
  assert.doesNotMatch(result.reply, /maazrat/i, "must not be the generic apology fallback");
});

test("Case 1b: valid duration_ask + reviewer timeout -> primary is delivered", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    languageReviewTimeoutMs: 10,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: timeoutReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
});

test("Case 1c: valid owner_check_holding + reviewer unavailable -> primary is delivered", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla", customerReference: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("Corolla ke liye abhi process jari hai, confirm hote hi bata dun ga.", {
        referencedItemId: "corolla-1",
        referencedItemSurface: "Corolla",
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla ke liye abhi process jari hai, confirm hote hi bata dun ga.");
});

// ============================================================
// Case 2: valid primary candidate, reviewer proposes a rewrite
// ============================================================

test("Case 2: reviewer proposes a rewrite -> Group re-composes once and ships regenerated primary, never reviewer text", async () => {
  let composeCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      return durationAskCompletion(
        composeCalls === 1
          ? "Corolla kitne din ke liye chahiye?"
          : "Corolla kitne din use karni hai?"
      );
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return reviewRewriteCompletion({
          reply: "Aapko Corolla kitne din ke liye chahiye hogi?",
          claims: [],
        });
      }
      return reviewRewriteCompletion({
        reply: "MUST_NOT_SHIP_REVIEWER",
        claims: [],
        overrides: { quality: "pass", issues: [] },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(composeCalls, 2);
  assert.equal(result.reply, "Corolla kitne din use karni hai?");
  assert.doesNotMatch(result.reply, /MUST_NOT_SHIP_REVIEWER/);
  assert.equal(result.generationDiagnostics?.finalSource, "regenerated_primary");
});

test("Case 2c: duration_ask incomplete_for_period re-composes once; reviewer text is never sent", async () => {
  let composeCalls = 0;
  let reviewCalls = 0;
  let secondComposeUser = "";
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async (args) => {
      composeCalls += 1;
      if (composeCalls === 2) {
        secondComposeUser = String(args?.messages?.[1]?.content ?? "");
      }
      return durationAskCompletion(
        composeCalls === 1
          ? "Aapko Corolla kitne din chahiye?"
          : "Corolla kitne din ke liye chahiye?"
      );
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return reviewRewriteCompletion({
          reply: "Aapko Corolla kitne din ke liye chahiye?",
          claims: [],
          overrides: {
            issues: ["incomplete_for_period"],
            dimensionChecks: {
              naturalWordOrder: "pass",
              modifierAttachment: "pass",
              spokenFluency: "pass",
              directnessAndEfficiency: "pass",
              objectiveFidelity: "rewrite",
              catalogDetailProportionality: "pass",
              personaConsistency: "pass",
              nativeLanguageExpression: "pass",
            },
          },
        });
      }
      return reviewRewriteCompletion({
        reply: "REVIEWER_MUST_NOT_SHIP",
        claims: [],
        overrides: { quality: "pass", issues: [] },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(composeCalls, 2);
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
  assert.doesNotMatch(result.reply, /REVIEWER_MUST_NOT_SHIP/);
  assert.match(secondComposeUser, /REJECTED_CANDIDATE:\nAapko Corolla kitne din chahiye\?/);
  assert.match(secondComposeUser, /WORDING_ISSUES:\nincomplete_for_period/);
  assert.match(secondComposeUser, /REPAIR_REQUIREMENT:/);
  assert.match(
    secondComposeUser,
    /number of days describes how long the customer will need\/use\/have the known item/
  );
  assert.doesNotMatch(secondComposeUser, /REVIEWER_MUST_NOT_SHIP/);
  assert.equal(result.generationDiagnostics?.finalSource, "regenerated_primary");
  assert.equal(
    result.generationDiagnostics?.firstCandidate,
    "Aapko Corolla kitne din chahiye?"
  );
  assert.deepEqual(result.generationDiagnostics?.firstReviewIssues, [
    "incomplete_for_period",
  ]);
  assert.equal(
    result.generationDiagnostics?.correctiveCandidate,
    "Corolla kitne din ke liye chahiye?"
  );
  assert.deepEqual(result.generationDiagnostics?.secondReviewIssues, []);
  assert.equal(result.generationDiagnostics?.correctiveAccepted, true);
});

test("Case 2d: second wording still rewrite -> fail closed without reviewer text or duration apology", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    fallbackReply: "Maazrat, rental duration ya dates bata dein taake main madad kar sakun.",
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Aapko Corolla kitne din chahiye?"),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewRewriteCompletion({
        reply: "REVIEWER_MUST_NOT_SHIP",
        claims: [],
        overrides: { issues: ["incomplete_for_period"] },
      }),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(
    result.reply,
    /REVIEWER_MUST_NOT_SHIP|rental duration ya dates|request complete nahi ho saki/i
  );
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
  assert.equal(
    result.generationDiagnostics?.finalSource,
    "forced_fallback_second_wording_rejected"
  );
  assert.equal(
    result.generationDiagnostics?.firstCandidate,
    "Aapko Corolla kitne din chahiye?"
  );
  assert.deepEqual(result.generationDiagnostics?.firstReviewIssues, [
    "incomplete_for_period",
  ]);
  assert.equal(
    result.generationDiagnostics?.correctiveCandidate,
    "Aapko Corolla kitne din chahiye?"
  );
  assert.deepEqual(result.generationDiagnostics?.secondReviewIssues, [
    "incomplete_for_period",
  ]);
  assert.equal(result.generationDiagnostics?.correctiveAccepted, false);
  const persisted = normalizePlaywrightOutboundTrace({
    kind: "duration_ask",
    customerReplyGenerationDiagnostics: result.generationDiagnostics,
  });
  assert.equal(
    persisted?.customerReplyGenerationDiagnostics?.firstCandidate,
    "Aapko Corolla kitne din chahiye?"
  );
  assert.deepEqual(
    persisted?.customerReplyGenerationDiagnostics?.firstReviewIssues,
    ["incomplete_for_period"]
  );
  assert.equal(
    persisted?.customerReplyGenerationDiagnostics?.correctiveCandidate,
    "Aapko Corolla kitne din chahiye?"
  );
  assert.deepEqual(
    persisted?.customerReplyGenerationDiagnostics?.secondReviewIssues,
    ["incomplete_for_period"]
  );
  assert.equal(
    persisted?.customerReplyGenerationDiagnostics?.correctiveAccepted,
    false
  );
  assert.equal(
    persisted?.customerReplyGenerationDiagnostics?.finalSource,
    "forced_fallback_second_wording_rejected"
  );
});

test("wording-repair exhaustion keeps the frozen act: same-act fallback, never a technical-failure apology", async () => {
  const apology =
    "Maazrat, abhi aapki request complete nahi ho saki. Please thori dair baad dobara try karein.";
  const rows = [
    {
      kind: "owner_check_holding",
      customerMessage: "Corolla 12 din k lye chyh phr",
      trustedFacts: {
        itemId: "corolla-1",
        itemLabel: "Corolla",
        customerReference: "Corolla",
      },
      completion: () =>
        ownerCheckHoldingCompletion(
          "Corolla ke liye abhi process jari hai, confirm hote hi bata dun ga.",
          {
            referencedItemId: "corolla-1",
            referencedItemSurface: "Corolla",
          }
        ),
      reviewClaims: ["resource_availability_unconfirmed"],
      reviewOverrides: {
        issues: ["unnatural_word_order"],
        customerInputRequested: false,
        requestedInput: null,
        availabilityCheckStarted: true,
        referencedItemId: "corolla-1",
        referencedItemSurface: "Corolla",
      },
    },
    {
      kind: "duration_ask",
      customerMessage: "Corolla available hai?",
      trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
      completion: () => durationAskCompletion("Aapko Corolla kitne din chahiye?"),
      reviewClaims: [],
      reviewOverrides: { issues: ["incomplete_for_period"] },
    },
  ];
  for (const row of rows) {
    const result = await composeCloudCanonicalCustomerReply({
      kind: row.kind,
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: row.customerMessage,
      trustedFacts: row.trustedFacts,
      fallbackReply: apology,
      timeoutMs: 8000,
      __chatCompletionsCreateForTests: async () => row.completion(),
      __languageQualityReviewChatCreateForTests: async () =>
        reviewRewriteCompletion({
          reply: "REVIEWER_MUST_NOT_SHIP",
          claims: row.reviewClaims,
          overrides: row.reviewOverrides,
        }),
    });
    const expected = sameActFallbackReply(row.kind, row.trustedFacts);
    assert.equal(result.ok, true, row.kind);
    assert.equal(result.outcome, "fallback", row.kind);
    assert.equal(
      result.generationDiagnostics?.finalSource,
      "forced_fallback_second_wording_rejected",
      row.kind
    );
    assert.equal(result.reply, expected, row.kind);
    assert.notEqual(result.reply, apology, row.kind);
    assert.doesNotMatch(result.reply, /REVIEWER_MUST_NOT_SHIP/i, row.kind);
  }
  assert.equal(
    sameActFallbackReply("owner_check_holding", {}),
    CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY
  );
});

test("Case 2b: reviewer returns quality=pass -> primary is delivered unchanged (same as pass would be under the old authoritative contract, still proven explicitly for Group)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewRewriteCompletion({
        reply: "Corolla kitne din ke liye chahiye?",
        claims: [],
        overrides: { quality: "pass", issues: [], dimensionChecks: {
          naturalWordOrder: "pass",
          modifierAttachment: "pass",
          spokenFluency: "pass",
          directnessAndEfficiency: "pass",
          objectiveFidelity: "pass",
          catalogDetailProportionality: "pass",
          personaConsistency: "pass",
          nativeLanguageExpression: "pass",
        } },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
});

// ============================================================
// Case 3 / 4: invalid primary candidate still goes through the existing
// deterministic corrective-compose + fail-closed path (reviewer plays no
// role in repairing meaning here).
// ============================================================

test("Case 3: invalid primary candidate (missing required structured input fields) triggers one corrective compose, which then succeeds", async () => {
  let composeCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      // First attempt: violates the structured duration-ask contract
      // (claims no input is being requested) -- deterministic guard must
      // reject this, not the reviewer.
      return composeCalls === 1
        ? durationAskCompletion("Corolla available hai.", {
            customerInputRequested: false,
            requestedInput: null,
          })
        : durationAskCompletion("Corolla kitne din ke liye chahiye?");
    },
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(composeCalls, 2, "exactly one corrective compose attempt");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
});

test("Case 3b: invalid primary candidate is rejected by the deterministic guard even when the reviewer would approve it (quality=pass) -- reviewer opinion never substitutes for deterministic validation", async () => {
  let composeCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      return composeCalls === 1
        ? durationAskCompletion("Corolla available hai.", {
            customerInputRequested: false,
            requestedInput: null,
          })
        : durationAskCompletion("Corolla kitne din ke liye chahiye?");
    },
    // The reviewer would happily approve the FIRST (invalid) candidate --
    // it is never even asked to, because the deterministic guard rejects
    // it before the reviewer step is reached at all. Only the corrective
    // (already-valid) candidate ever reaches review, and even then its
    // pass verdict changes nothing since Group already delivers it as-is.
    __languageQualityReviewChatCreateForTests: async ({ messages }) => {
      const userContent = String(messages?.at(-1)?.content ?? "");
      assert.doesNotMatch(
        userContent,
        /Corolla available hai\.$/m,
        "the invalid first candidate must never reach the reviewer"
      );
      return reviewRewriteCompletion({
        reply: "Corolla kitne din ke liye chahiye?",
        claims: [],
        overrides: {
          quality: "pass",
          issues: [],
          dimensionChecks: {
            naturalWordOrder: "pass",
            modifierAttachment: "pass",
            spokenFluency: "pass",
            directnessAndEfficiency: "pass",
            objectiveFidelity: "pass",
            catalogDetailProportionality: "pass",
            personaConsistency: "pass",
            nativeLanguageExpression: "pass",
          },
        },
      });
    },
  });
  assert.equal(composeCalls, 2, "the invalid candidate is corrected by the deterministic retry, not by the reviewer");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla kitne din ke liye chahiye?");
});

test("Case 4: corrective candidate also invalid -> existing safe fail-closed/fallback behavior is preserved (no new fallback system)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla available hai.", {
        customerInputRequested: false,
        requestedInput: null,
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.doesNotMatch(result.reply, /request complete nahi ho saki/i);
});

// ============================================================
// Persona / customerReference protections must remain intact.
// ============================================================

test("customerReference is preserved end to end when reviewer is unavailable (item-reference provenance still enforced)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla", customerReference: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("Filhaal koi update nahi.", {
        // Missing referencedItemId/referencedItemSurface entirely --
        // provenance check must still reject this primary candidate.
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback", "item-reference provenance guard must still fail closed");
});

test("internal-actor leakage (owner/staff mention) is still rejected by the deterministic guard, not the reviewer", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("Owner se confirm karwa rahe hain."),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
});

test("false confirmed-availability claim in the primary candidate is still rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla available hai, kitne din ke liye chahiye?", {
        replySemantics: {
          claims: ["resource_availability_confirmed"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.notEqual(result.reply, "Corolla available hai, kitne din ke liye chahiye?");
});

test("false unavailable claim in the primary candidate is still rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla available nahi hai, kitne din ke liye chahiye?", {
        replySemantics: {
          claims: ["resource_unavailable"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.notEqual(result.reply, "Corolla available nahi hai, kitne din ke liye chahiye?");
});

test("price/quotation claim leaked in the primary candidate is still rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla ka rate Rs 8000 hai, kitne din ke liye chahiye?", {
        replySemantics: {
          claims: ["quotation_verified"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.notEqual(result.reply, "Corolla ka rate Rs 8000 hai, kitne din ke liye chahiye?");
});

test("booking-success claim in the primary candidate is still rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Aapki booking confirm ho gayi hai.", {
        replySemantics: {
          claims: ["reservation_created"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.notEqual(result.reply, "Aapki booking confirm ho gayi hai.");
});

test("unsupported exact-timing promise in the primary candidate is still rejected", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("5 minute mein confirm ho jaye ga."),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.notEqual(result.reply, "5 minute mein confirm ho jaye ga.");
});

test("customerReference is present and correctly declared in the primary candidate is delivered as-is (positive provenance proof, independent of reviewer status)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla", customerReference: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("Corolla ke liye process jari hai.", {
        referencedItemId: "corolla-1",
        referencedItemSurface: "Corolla",
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      reviewRewriteCompletion({
        // Reviewer proposes dropping the customer's own item wording --
        // must be ignored for Group regardless, so provenance stays intact.
        reply: "Process jari hai.",
        claims: ["resource_availability_unconfirmed"],
        overrides: { referencedItemId: null, referencedItemSurface: null },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, "Corolla ke liye process jari hai.");
  assert.match(result.reply, /Corolla/);
});

test("owner_check_holding required meaning (resource_availability_unconfirmed) is still enforced on the primary candidate regardless of reviewer status", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla ke liye koi update?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      ownerCheckHoldingCompletion("Corolla ke liye filhaal koi update nahi hai.", {
        replySemantics: {
          claims: [],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    __languageQualityReviewChatCreateForTests: async () =>
      // Even a reviewer that would happily "pass" the meaning-deficient
      // candidate has no authority to let it through -- the required-claim
      // check is deterministic and runs on the primary regardless.
      reviewRewriteCompletion({
        reply: "Corolla ke liye filhaal koi update nahi hai.",
        claims: [],
        overrides: {
          quality: "pass",
          issues: [],
          dimensionChecks: {
            naturalWordOrder: "pass",
            modifierAttachment: "pass",
            spokenFluency: "pass",
            directnessAndEfficiency: "pass",
            objectiveFidelity: "pass",
            catalogDetailProportionality: "pass",
            personaConsistency: "pass",
            nativeLanguageExpression: "pass",
          },
        },
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback", "missing the required resource_availability_unconfirmed claim must still fail closed");
  assert.notEqual(result.reply, "Corolla ke liye filhaal koi update nahi hai.");
});

// ============================================================
// DM/Cloud (channel="dm") must be completely unaffected by this fix --
// the reviewer keeps its existing authority there.
// ============================================================

test("DM channel is unaffected: reviewer unavailable still forces the existing fallback behavior (unchanged)", async () => {
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Corolla kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: throwingReviewer,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "fallback");
  assert.notEqual(
    result.outcome,
    "ai_success",
    "DM channel must keep the reviewer as a blocking authority"
  );
  assert.equal(
    result.reply,
    sameActFallbackReply("duration_ask", {
      itemId: "corolla-1",
      itemLabel: "Corolla",
    })
  );
  assert.doesNotMatch(result.reply, /request complete nahi ho saki/i);
});
