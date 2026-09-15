/**
 * duration_ask meaning contract: reviewer may rewrite drifted wording on DM;
 * Group delivery stays primary-candidate (reviewer non-blocking).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function durationAskCompletion(customerReply) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
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
        }),
      },
    }],
  };
}

function reviewCompletion(quality, reply, issues = []) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          quality,
          issues,
          dimensionChecks: {
            naturalWordOrder: "pass",
            modifierAttachment: quality === "rewrite" ? "rewrite" : "pass",
            spokenFluency: "pass",
            directnessAndEfficiency: "pass",
            objectiveFidelity: quality === "rewrite" ? "rewrite" : "pass",
            catalogDetailProportionality: "pass",
            personaConsistency: "pass",
            nativeLanguageExpression: "pass",
          },
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
        }),
      },
    }],
  };
}

const FACTS = {
  itemId: "item_alpha_1",
  itemLabel: "Item Alpha",
  business: { businessType: "Automotive" },
};

test("DM reviewer rewrite of vague-time duration_ask is wording-only and is delivered", async () => {
  let reviewSystem = "";
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "dm",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha available hai?",
    trustedFacts: FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () =>
      durationAskCompletion("Aapko Item Alpha kitni dair chahiye?"),
    __languageQualityReviewChatCreateForTests: async (args) => {
      reviewSystem = String(args.messages?.[0]?.content ?? "");
      return reviewCompletion(
        "rewrite",
        "Item Alpha aapko kitne din ke liye chahiye?",
        ["vague_or_clock_time_drift"]
      );
    },
  });
  assert.match(reviewSystem, /FROZEN_REPLY_MEANING/);
  assert.match(reviewSystem, /duration of use/i);
  assert.match(reviewSystem, /incomplete_for_period/);
  assert.match(reviewSystem, /duration-of-use relationship itself is mandatory/);
  assert.doesNotMatch(reviewSystem, /expectedUnit|rental_duration|(?<!incomplete_)for_period|\brental_period\b|collect_missing_rental_period/);
  assert.doesNotMatch(reviewSystem, /ke liye regex|kitni dair/i);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Item Alpha aapko kitne din ke liye chahiye?");
});

test("Group duration_ask re-composes once on a wording rewrite and never ships reviewer text", async () => {
  let composeCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha available hai?",
    trustedFacts: FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      return durationAskCompletion(
        composeCalls === 1
          ? "Aapko Item Alpha kitne din ke liye chahiye?"
          : "Item Alpha kitne din use karni hai?"
      );
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return reviewCompletion(
          "rewrite",
          "FALLBACK_SHOULD_NOT_SHIP",
          ["duration_unit_drift"]
        );
      }
      return reviewCompletion("pass", "MUST_NOT_SHIP");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(composeCalls, 2);
  assert.equal(result.reply, "Item Alpha kitne din use karni hai?");
  assert.doesNotMatch(result.reply, /FALLBACK_SHOULD_NOT_SHIP|MUST_NOT_SHIP/);
});

test("Group duration_ask re-composes once on incomplete_for_period and never ships reviewer text", async () => {
  let composeCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha available hai?",
    trustedFacts: FACTS,
    fallbackReply: "Maazrat, rental duration ya dates bata dein taake main madad kar sakun.",
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      return durationAskCompletion(
        composeCalls === 1
          ? "Aapko Item Alpha kitne din chahiye?"
          : "Item Alpha kitne din ke liye chahiye?"
      );
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return reviewCompletion(
          "rewrite",
          "Item Alpha aapko kitne din ke liye chahiye?",
          ["incomplete_for_period"]
        );
      }
      return reviewCompletion("pass", "MUST_NOT_SHIP");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reply, "Item Alpha kitne din ke liye chahiye?");
  assert.doesNotMatch(result.reply, /MUST_NOT_SHIP|Maazrat, rental duration/i);
  assert.equal(result.generationDiagnostics?.finalSource, "regenerated_primary");
  assert.equal(
    result.generationDiagnostics?.firstCandidate,
    "Aapko Item Alpha kitne din chahiye?"
  );
  assert.deepEqual(result.generationDiagnostics?.firstReviewIssues, [
    "incomplete_for_period",
  ]);
  assert.equal(
    result.generationDiagnostics?.correctiveCandidate,
    "Item Alpha kitne din ke liye chahiye?"
  );
  assert.equal(result.generationDiagnostics?.correctiveAccepted, true);
});

test("temporal_clarification does not inherit duration_ask frozen meaning or days unit", async () => {
  let system = "";
  await composeCloudCanonicalCustomerReply({
    kind: "temporal_clarification",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "kal se",
    trustedFacts: {
      itemId: "item_alpha_1",
      itemLabel: "Item Alpha",
      dateIssueReason: "ambiguous_date",
      business: { businessType: "Automotive" },
    },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      system = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply: "Item Alpha kis date se chahiye?",
              customerInputRequested: true,
              requestedInput: "start_date",
              availabilityCheckStarted: false,
              replySemantics: {
                claims: [],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        }],
      };
    },
  });
  assert.doesNotMatch(system, /FROZEN_REPLY_MEANING/);
  assert.doesNotMatch(system, /"expectedUnit":"days"/);
  assert.match(system, /requestedInput=start_date|requestedInput":"start_date"|start_date/);
});

test("duration_ask composer prompt carries frozen meaning and no date-interchange instruction", async () => {
  let system = "";
  let user = "";
  await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha available hai?",
    trustedFacts: FACTS,
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      system = String(args.messages?.[0]?.content ?? "");
      user = String(args.messages?.[1]?.content ?? "");
      return durationAskCompletion("Item Alpha kitne din ke liye chahiye?");
    },
  });
  assert.match(system, /FROZEN_REPLY_MEANING/);
  assert.match(system, /duration of use of the already-known item in days/i);
  assert.match(system, /duration-of-use relationship unmistakable/i);
  assert.doesNotMatch(system, /how many days they need the trusted item for/i);
  assert.doesNotMatch(system, /Frozen expected unit: days/);
  assert.doesNotMatch(system, /for_period|rental_period|rental_duration|collect_missing_rental_period|usage\/rental period/);
  assert.doesNotMatch(user, /SEMANTIC_INTENT/);
  assert.doesNotMatch(system, /day count and specific dates/i);
  assert.doesNotMatch(system, /Civic|Corolla|Stonic/);
});

test("duration_ask does not invent expectedUnit days when business policy is not day-based", async () => {
  let system = "";
  await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Item Alpha available hai?",
    trustedFacts: {
      itemId: "item_alpha_1",
      itemLabel: "Item Alpha",
      business: { category: "spa" },
    },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async (args) => {
      system = String(args.messages?.[0]?.content ?? "");
      return durationAskCompletion("Item Alpha kitne din ke liye chahiye?");
    },
  });
  assert.match(system, /FROZEN_REPLY_MEANING/);
  assert.match(system, /without inventing a unit/i);
  assert.doesNotMatch(system, /how many days they need the trusted item for/i);
  assert.doesNotMatch(system, /Frozen expected unit: days/);
});
